<?php
/**
 * Media ingestion.
 *
 * Three ingestion modes, from fastest to most compatible:
 *   register  – files were already written into wp-content/uploads by the app (Local sites, SFTP);
 *               the plugin only registers the attachment and its pre-computed size metadata.
 *   upload    – the app sends the optimized original plus every registered sub-size it already
 *               generated, as one binary body described by the X-CF-Manifest header. The server
 *               does no image processing at all.
 *   sideload  – the server downloads a remote URL and lets WordPress generate sizes (fallback).
 *
 * All modes de-duplicate by SHA-256 of the original file.
 *
 * @package CatalogForge
 */

defined( 'ABSPATH' ) || exit;

class CF_Media {

	const ALLOWED = array(
		'image/jpeg' => array( 'jpg', 'jpeg' ),
		'image/png'  => array( 'png' ),
		'image/webp' => array( 'webp' ),
		'image/avif' => array( 'avif' ),
		'image/gif'  => array( 'gif' ),
	);

	public static function find_by_sha( $sha ) {
		global $wpdb;
		if ( ! preg_match( '/^[a-f0-9]{64}$/', (string) $sha ) ) {
			return 0;
		}
		return (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT pm.post_id FROM {$wpdb->postmeta} pm INNER JOIN {$wpdb->posts} p ON p.ID = pm.post_id
				 WHERE pm.meta_key = '_cf_sha256' AND pm.meta_value = %s AND p.post_type = 'attachment' LIMIT 1",
				$sha
			)
		);
	}

	private static function ext_for_mime( $mime ) {
		return isset( self::ALLOWED[ $mime ] ) ? self::ALLOWED[ $mime ][0] : '';
	}

	private static function decode_manifest( $header ) {
		$json = base64_decode( strtr( (string) $header, '-_', '+/' ), true );
		$data = $json ? json_decode( $json, true ) : null;
		return is_array( $data ) ? $data : null;
	}

	/**
	 * Binary upload of original + pre-generated sizes.
	 *
	 * @param WP_REST_Request $request Request.
	 */
	public static function upload( $request ) {
		$manifest = self::decode_manifest( $request->get_header( 'x_cf_manifest' ) );
		if ( ! $manifest || empty( $manifest['parts'] ) ) {
			return new WP_Error( 'cf_manifest', 'Missing or invalid X-CF-Manifest.', array( 'status' => 400 ) );
		}
		$sha = strtolower( (string) ( $manifest['sha256'] ?? '' ) );
		if ( $existing = self::find_by_sha( $sha ) ) {
			self::apply_text( $existing, $manifest, false );
			return array( 'deduplicated' => true, 'media' => CF_Serializer::media( $existing ) );
		}

		$body  = (string) $request->get_body();
		$parts = array();
		foreach ( $manifest['parts'] as $part ) {
			$offset = (int) ( $part['offset'] ?? -1 );
			$length = (int) ( $part['length'] ?? -1 );
			if ( $offset < 0 || $length <= 0 || $offset + $length > strlen( $body ) ) {
				return new WP_Error( 'cf_part', 'Manifest part out of bounds.', array( 'status' => 400 ) );
			}
			$mime = (string) ( $part['mime'] ?? $manifest['mime'] ?? '' );
			if ( ! self::ext_for_mime( $mime ) ) {
				return new WP_Error( 'cf_mime', "Unsupported image type {$mime}.", array( 'status' => 415 ) );
			}
			$parts[ (string) $part['name'] ] = array(
				'bytes'  => substr( $body, $offset, $length ),
				'width'  => (int) ( $part['width'] ?? 0 ),
				'height' => (int) ( $part['height'] ?? 0 ),
				'mime'   => $mime,
			);
		}
		if ( empty( $parts['full'] ) ) {
			return new WP_Error( 'cf_part', 'Manifest must include a "full" part.', array( 'status' => 400 ) );
		}
		if ( $sha && hash( 'sha256', $parts['full']['bytes'] ) !== $sha ) {
			return new WP_Error( 'cf_integrity', 'Checksum mismatch for the uploaded original.', array( 'status' => 422 ) );
		}

		$uploads = wp_upload_dir( null, true );
		if ( ! empty( $uploads['error'] ) ) {
			return new WP_Error( 'cf_uploads', $uploads['error'], array( 'status' => 500 ) );
		}
		$ext      = self::ext_for_mime( $parts['full']['mime'] );
		$base     = sanitize_file_name( pathinfo( (string) ( $manifest['filename'] ?? 'image' ), PATHINFO_FILENAME ) );
		$base     = '' === $base ? 'image' : $base;
		$filename = wp_unique_filename( $uploads['path'], $base . '.' . $ext );
		$stem     = pathinfo( $filename, PATHINFO_FILENAME );
		$full     = trailingslashit( $uploads['path'] ) . $filename;

		if ( false === file_put_contents( $full, $parts['full']['bytes'] ) ) {
			return new WP_Error( 'cf_write', 'Could not write to the uploads directory.', array( 'status' => 500 ) );
		}
		// Verify the bytes really are the claimed image type.
		$check = wp_check_filetype_and_ext( $full, $filename );
		if ( empty( $check['type'] ) || ! isset( self::ALLOWED[ $check['type'] ] ) ) {
			wp_delete_file( $full );
			return new WP_Error( 'cf_mime', 'File content is not an allowed image.', array( 'status' => 415 ) );
		}

		$sizes = array();
		foreach ( $parts as $name => $part ) {
			if ( 'full' === $name ) {
				continue;
			}
			$size_file = sprintf( '%s-%dx%d.%s', $stem, $part['width'], $part['height'], self::ext_for_mime( $part['mime'] ) );
			file_put_contents( trailingslashit( $uploads['path'] ) . $size_file, $part['bytes'] );
			$sizes[ sanitize_key( $name ) ] = array(
				'file'      => $size_file,
				'width'     => $part['width'],
				'height'    => $part['height'],
				'mime-type' => $part['mime'],
				'filesize'  => strlen( $part['bytes'] ),
			);
		}

		$id = self::insert_attachment( $full, $check['type'], $manifest );
		if ( is_wp_error( $id ) ) {
			return $id;
		}
		if ( $sizes || ! empty( $manifest['skip_server_sizes'] ) ) {
			wp_update_attachment_metadata(
				$id,
				array(
					'width'      => $parts['full']['width'],
					'height'     => $parts['full']['height'],
					'file'       => _wp_relative_upload_path( $full ),
					'filesize'   => strlen( $parts['full']['bytes'] ),
					'sizes'      => $sizes,
					'image_meta' => array(),
				)
			);
		} else {
			require_once ABSPATH . 'wp-admin/includes/image.php';
			wp_update_attachment_metadata( $id, wp_generate_attachment_metadata( $id, $full ) );
		}
		if ( $sha ) {
			update_post_meta( $id, '_cf_sha256', $sha );
		}
		return array( 'deduplicated' => false, 'media' => CF_Serializer::media( $id ) );
	}

	/**
	 * Registers files the app already placed inside the uploads directory.
	 *
	 * @param WP_REST_Request $request Request.
	 */
	public static function register( $request ) {
		$data = CF_Auth::json_body( $request );
		$sha  = strtolower( (string) ( $data['sha256'] ?? '' ) );
		if ( $existing = self::find_by_sha( $sha ) ) {
			return array( 'deduplicated' => true, 'media' => CF_Serializer::media( $existing ) );
		}
		$uploads = wp_upload_dir( null, false );
		$basedir = realpath( $uploads['basedir'] );
		$full    = realpath( trailingslashit( $uploads['basedir'] ) . ltrim( (string) ( $data['relative_path'] ?? '' ), '/' ) );
		if ( ! $basedir || ! $full || 0 !== strpos( $full, $basedir . DIRECTORY_SEPARATOR ) || ! is_file( $full ) ) {
			return new WP_Error( 'cf_path', 'File not found inside the uploads directory.', array( 'status' => 404 ) );
		}
		$check = wp_check_filetype_and_ext( $full, basename( $full ) );
		if ( empty( $check['type'] ) || ! isset( self::ALLOWED[ $check['type'] ] ) ) {
			return new WP_Error( 'cf_mime', 'File is not an allowed image.', array( 'status' => 415 ) );
		}
		$dir   = dirname( $full );
		$sizes = array();
		foreach ( (array) ( $data['sizes'] ?? array() ) as $s ) {
			$file = basename( (string) ( $s['file'] ?? '' ) );
			if ( '' === $file || ! is_file( $dir . DIRECTORY_SEPARATOR . $file ) ) {
				continue;
			}
			$sizes[ sanitize_key( $s['name'] ?? '' ) ] = array(
				'file'      => $file,
				'width'     => (int) ( $s['width'] ?? 0 ),
				'height'    => (int) ( $s['height'] ?? 0 ),
				'mime-type' => (string) ( $s['mime'] ?? $check['type'] ),
				'filesize'  => (int) filesize( $dir . DIRECTORY_SEPARATOR . $file ),
			);
		}
		$id = self::insert_attachment( $full, $check['type'], $data );
		if ( is_wp_error( $id ) ) {
			return $id;
		}
		if ( $sizes ) {
			wp_update_attachment_metadata(
				$id,
				array(
					'width'      => (int) ( $data['width'] ?? 0 ),
					'height'     => (int) ( $data['height'] ?? 0 ),
					'file'       => _wp_relative_upload_path( $full ),
					'filesize'   => (int) filesize( $full ),
					'sizes'      => $sizes,
					'image_meta' => array(),
				)
			);
		} else {
			require_once ABSPATH . 'wp-admin/includes/image.php';
			wp_update_attachment_metadata( $id, wp_generate_attachment_metadata( $id, $full ) );
		}
		if ( $sha ) {
			update_post_meta( $id, '_cf_sha256', $sha );
		}
		return array( 'deduplicated' => false, 'media' => CF_Serializer::media( $id ) );
	}

	/**
	 * Server-side download of a remote image (compatibility fallback).
	 *
	 * @param WP_REST_Request $request Request.
	 */
	public static function sideload( $request ) {
		global $wpdb;
		$data = CF_Auth::json_body( $request );
		$url  = esc_url_raw( (string) ( $data['url'] ?? '' ) );
		if ( ! $url || ! wp_http_validate_url( $url ) ) {
			return new WP_Error( 'cf_url', 'A public http(s) URL is required.', array( 'status' => 400 ) );
		}
		$existing = (int) $wpdb->get_var( $wpdb->prepare( "SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_cf_source_url' AND meta_value = %s LIMIT 1", $url ) );
		if ( $existing && 'attachment' === get_post_type( $existing ) ) {
			return array( 'deduplicated' => true, 'media' => CF_Serializer::media( $existing ) );
		}
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';
		$tmp = download_url( $url, 60 );
		if ( is_wp_error( $tmp ) ) {
			return $tmp;
		}
		$sha = hash_file( 'sha256', $tmp );
		if ( $dupe = self::find_by_sha( $sha ) ) {
			wp_delete_file( $tmp );
			update_post_meta( $dupe, '_cf_source_url', $url );
			return array( 'deduplicated' => true, 'media' => CF_Serializer::media( $dupe ) );
		}
		$name = ! empty( $data['filename'] ) ? sanitize_file_name( $data['filename'] ) : wp_basename( wp_parse_url( $url, PHP_URL_PATH ) );
		$id   = media_handle_sideload( array( 'name' => $name, 'tmp_name' => $tmp ), (int) ( $data['parent_id'] ?? 0 ), $data['title'] ?? null );
		if ( is_wp_error( $id ) ) {
			wp_delete_file( $tmp );
			return $id;
		}
		update_post_meta( $id, '_cf_sha256', $sha );
		update_post_meta( $id, '_cf_source_url', $url );
		self::apply_text( $id, $data, true );
		return array( 'deduplicated' => false, 'media' => CF_Serializer::media( $id ) );
	}

	private static function insert_attachment( $full, $mime, array $data ) {
		$title = isset( $data['title'] ) && '' !== $data['title'] ? sanitize_text_field( $data['title'] ) : preg_replace( '/\.[^.]+$/', '', wp_basename( $full ) );
		$id    = wp_insert_attachment(
			array(
				'post_mime_type' => $mime,
				'post_title'     => $title,
				'post_excerpt'   => isset( $data['caption'] ) ? wp_kses_post( $data['caption'] ) : '',
				'post_status'    => 'inherit',
				'guid'           => trailingslashit( wp_upload_dir( null, false )['baseurl'] ) . _wp_relative_upload_path( $full ),
			),
			$full,
			(int) ( $data['parent_id'] ?? 0 ),
			true
		);
		if ( ! is_wp_error( $id ) ) {
			self::apply_text( $id, $data, false );
		}
		return $id;
	}

	private static function apply_text( $id, array $data, $with_title ) {
		if ( isset( $data['alt'] ) && '' !== $data['alt'] ) {
			update_post_meta( $id, '_wp_attachment_image_alt', sanitize_text_field( $data['alt'] ) );
		}
		if ( $with_title && ! empty( $data['title'] ) ) {
			wp_update_post( array( 'ID' => $id, 'post_title' => sanitize_text_field( $data['title'] ) ) );
		}
	}

	/**
	 * Paged media library listing.
	 *
	 * @param WP_REST_Request $request Request.
	 */
	public static function listing( $request ) {
		$per_page = min( 500, max( 1, (int) ( $request->get_param( 'per_page' ) ?: 100 ) ) );
		$page     = max( 1, (int) ( $request->get_param( 'page' ) ?: 1 ) );
		$args     = array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'post_mime_type' => 'image',
			'posts_per_page' => $per_page,
			'paged'          => $page,
			'orderby'        => 'ID',
			'order'          => 'DESC',
			'fields'         => 'ids',
		);
		if ( $request->get_param( 'search' ) ) {
			$args['s'] = sanitize_text_field( $request->get_param( 'search' ) );
		}
		if ( $request->get_param( 'ids' ) ) {
			$args['post__in']       = array_map( 'intval', explode( ',', (string) $request->get_param( 'ids' ) ) );
			$args['posts_per_page'] = count( $args['post__in'] );
			$args['paged']          = 1;
		}
		$q     = new WP_Query( $args );
		$items = array();
		foreach ( $q->posts as $id ) {
			$m = CF_Serializer::media( $id );
			if ( $m ) {
				$items[] = $m;
			}
		}
		return array( 'items' => $items, 'total' => (int) $q->found_posts, 'pages' => (int) $q->max_num_pages );
	}
}
