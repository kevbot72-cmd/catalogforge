<?php
/**
 * REST routes under /catalogforge/v1. All routes require a valid CatalogForge signature.
 *
 * @package CatalogForge
 */

defined( 'ABSPATH' ) || exit;

class CF_Api {

	const NS = 'catalogforge/v1';

	public static function register_routes() {
		$auth = array( 'CF_Auth', 'check' );
		$routes = array(
			array( '/handshake', 'GET', array( __CLASS__, 'handshake' ) ),
			array( '/index', 'GET', array( __CLASS__, 'index' ) ),
			array( '/catalog', 'GET', array( __CLASS__, 'catalog' ) ),
			array( '/taxonomy', 'GET', array( __CLASS__, 'taxonomy' ) ),
			array( '/batch', 'POST', array( __CLASS__, 'batch' ) ),
			array( '/media', 'GET', array( 'CF_Media', 'listing' ) ),
			array( '/media', 'POST', array( 'CF_Media', 'upload' ) ),
			array( '/media/register', 'POST', array( 'CF_Media', 'register' ) ),
			array( '/media/sideload', 'POST', array( 'CF_Media', 'sideload' ) ),
			array( '/preview', 'POST', array( 'CF_Preview', 'create' ) ),
		);
		foreach ( $routes as list( $path, $method, $cb ) ) {
			register_rest_route(
				self::NS,
				$path,
				array(
					'methods'             => $method,
					'callback'            => $cb,
					'permission_callback' => $auth,
				)
			);
		}
	}

	private static function bytes( $v ) {
		return function_exists( 'wp_convert_hr_to_bytes' ) ? wp_convert_hr_to_bytes( $v ) : (int) $v;
	}

	public static function handshake() {
		global $wp_version;
		$sizes = array();
		foreach ( wp_get_registered_image_subsizes() as $name => $s ) {
			$sizes[] = array(
				'name'   => $name,
				'width'  => (int) $s['width'],
				'height' => (int) $s['height'],
				'crop'   => ! empty( $s['crop'] ),
			);
		}
		$hpos = class_exists( \Automattic\WooCommerce\Utilities\OrderUtil::class )
			&& \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled();

		return array(
			'protocol'            => CATALOGFORGE_PROTOCOL,
			'plugin_version'      => CATALOGFORGE_VERSION,
			'wp_version'          => $wp_version,
			'wc_version'          => defined( 'WC_VERSION' ) ? WC_VERSION : null,
			'php_version'         => PHP_VERSION,
			'site_name'           => get_bloginfo( 'name' ),
			'home_url'            => home_url( '/' ),
			'server_time'         => time(),
			'hpos'                => $hpos,
			'currency'            => get_woocommerce_currency(),
			'currency_symbol'     => html_entity_decode( get_woocommerce_currency_symbol() ),
			'price_decimals'      => wc_get_price_decimals(),
			'weight_unit'         => get_option( 'woocommerce_weight_unit' ),
			'dimension_unit'      => get_option( 'woocommerce_dimension_unit' ),
			'image_sizes'         => $sizes,
			'big_image_threshold' => (int) apply_filters( 'big_image_size_threshold', 2560, array( 0, 0 ), '', 0 ),
			'max_upload_bytes'    => min( wp_max_upload_size(), self::bytes( ini_get( 'post_max_size' ) ) ),
			'memory_limit'        => ini_get( 'memory_limit' ),
			'max_execution_time'  => (int) ini_get( 'max_execution_time' ),
			'recommended_batch'   => 250,
			'image_formats'       => array_values(
				array_filter(
					array( 'image/webp', 'image/avif' ),
					static function ( $m ) {
						return wp_image_editor_supports( array( 'mime_type' => $m ) ) || in_array( $m, get_allowed_mime_types(), true );
					}
				)
			),
			'integrations'        => array(
				'yoast'    => defined( 'WPSEO_VERSION' ),
				'rankmath' => defined( 'RANK_MATH_VERSION' ),
				'wpml'     => defined( 'ICL_SITEPRESS_VERSION' ),
				'polylang' => defined( 'POLYLANG_VERSION' ),
				'acf'      => class_exists( 'ACF' ),
				'brands'   => taxonomy_exists( 'product_brand' ),
			),
		);
	}

	/**
	 * Compact id + modified-time index of every product and variation, used for delta sync and
	 * deletion detection without transferring full records.
	 */
	public static function index() {
		global $wpdb;
		$rows = $wpdb->get_results(
			"SELECT ID, post_parent, post_type, post_modified_gmt FROM {$wpdb->posts}
			 WHERE post_type IN ('product','product_variation') AND post_status NOT IN ('trash','auto-draft')
			 ORDER BY ID",
			ARRAY_N
		);
		$placeholder = (int) get_option( 'catalogforge_preview_placeholder' );
		$out         = array();
		foreach ( $rows as $r ) {
			if ( (int) $r[0] === $placeholder ) {
				continue;
			}
			$out[] = array( (int) $r[0], (int) $r[1], 'product_variation' === $r[2] ? 1 : 0, $r[3] );
		}
		return array( 'items' => $out, 'server_time' => time() );
	}

	/**
	 * Keyset-paginated full records. Params: after_id, limit (≤1000), ids (csv), modified_after
	 * (Y-m-d H:i:s GMT), meta_keys (csv).
	 */
	public static function catalog( WP_REST_Request $request ) {
		global $wpdb;
		$limit    = min( 1000, max( 1, (int) ( $request->get_param( 'limit' ) ?: 250 ) ) );
		$after_id = max( 0, (int) $request->get_param( 'after_id' ) );
		$where    = "post_type IN ('product','product_variation') AND post_status NOT IN ('trash','auto-draft')";
		$args     = array();

		if ( $request->get_param( 'ids' ) ) {
			$ids   = array_filter( array_map( 'intval', explode( ',', (string) $request->get_param( 'ids' ) ) ) );
			$ids   = $ids ? $ids : array( 0 );
			$where .= ' AND ID IN (' . implode( ',', $ids ) . ')';
		} else {
			$where .= ' AND ID > %d';
			$args[] = $after_id;
		}
		if ( $request->get_param( 'modified_after' ) ) {
			$where .= ' AND post_modified_gmt > %s';
			$args[] = (string) $request->get_param( 'modified_after' );
		}
		$placeholder = (int) get_option( 'catalogforge_preview_placeholder' );
		if ( $placeholder ) {
			$where .= ' AND ID <> %d';
			$args[] = $placeholder;
		}
		$args[] = $limit;
		$sql    = "SELECT ID FROM {$wpdb->posts} WHERE {$where} ORDER BY ID ASC LIMIT %d";
		$ids    = array_map( 'intval', $wpdb->get_col( $wpdb->prepare( $sql, $args ) ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		_prime_post_caches( $ids, true, true );
		$meta_keys = array_filter( array_map( 'trim', explode( ',', (string) $request->get_param( 'meta_keys' ) ) ) );
		$products  = array();
		$media_ids = array();
		foreach ( $ids as $id ) {
			$p = wc_get_product( $id );
			if ( ! $p ) {
				continue;
			}
			$row        = CF_Serializer::product( $p, $meta_keys );
			$products[] = $row;
			if ( $row['image_id'] ) {
				$media_ids[] = $row['image_id'];
			}
			foreach ( $row['gallery_ids'] as $g ) {
				$media_ids[] = $g;
			}
		}
		$media_ids = array_values( array_unique( $media_ids ) );
		_prime_post_caches( $media_ids, false, true );
		$media = array();
		foreach ( $media_ids as $mid ) {
			$m = CF_Serializer::media( $mid );
			if ( $m ) {
				$media[] = $m;
			}
		}
		return array(
			'products'    => $products,
			'media'       => $media,
			'next_after'  => count( $ids ) === $limit ? end( $ids ) : null,
			'server_time' => time(),
		);
	}

	public static function taxonomy() {
		$cats = array();
		foreach ( get_terms( array( 'taxonomy' => 'product_cat', 'hide_empty' => false ) ) as $t ) {
			$cats[] = CF_Serializer::category( $t );
		}
		$tags = array();
		foreach ( get_terms( array( 'taxonomy' => 'product_tag', 'hide_empty' => false ) ) as $t ) {
			$tags[] = array( 'id' => $t->term_id, 'name' => $t->name, 'slug' => $t->slug, 'count' => (int) $t->count );
		}
		$attrs = array();
		foreach ( wc_get_attribute_taxonomies() as $a ) {
			$tax   = wc_attribute_taxonomy_name( $a->attribute_name );
			$terms = array();
			if ( taxonomy_exists( $tax ) ) {
				foreach ( get_terms( array( 'taxonomy' => $tax, 'hide_empty' => false ) ) as $t ) {
					$terms[] = array( 'id' => $t->term_id, 'name' => $t->name, 'slug' => $t->slug );
				}
			}
			$attrs[] = array(
				'id'       => (int) $a->attribute_id,
				'name'     => $a->attribute_label,
				'taxonomy' => $tax,
				'type'     => $a->attribute_type,
				'terms'    => $terms,
			);
		}
		$shipping = array();
		foreach ( get_terms( array( 'taxonomy' => 'product_shipping_class', 'hide_empty' => false ) ) as $t ) {
			$shipping[] = array( 'id' => $t->term_id, 'name' => $t->name, 'slug' => $t->slug );
		}
		$media_ids = array();
		foreach ( $cats as $c ) {
			foreach ( array( 'image_id', 'banner_id' ) as $k ) {
				if ( $c[ $k ] ) {
					$media_ids[] = $c[ $k ];
				}
			}
		}
		$media = array();
		foreach ( array_unique( $media_ids ) as $mid ) {
			$m = CF_Serializer::media( $mid );
			if ( $m ) {
				$media[] = $m;
			}
		}
		return array(
			'categories'       => $cats,
			'tags'             => $tags,
			'attributes'       => $attrs,
			'shipping_classes' => $shipping,
			'tax_classes'      => WC_Tax::get_tax_class_slugs(),
			'media'            => $media,
		);
	}

	public static function batch( WP_REST_Request $request ) {
		$body = CF_Auth::json_body( $request );
		if ( empty( $body['ops'] ) || ! is_array( $body['ops'] ) ) {
			return new WP_Error( 'cf_batch', 'Body must contain an "ops" array.', array( 'status' => 400 ) );
		}
		if ( count( $body['ops'] ) > 2000 ) {
			return new WP_Error( 'cf_batch', 'At most 2000 operations per request.', array( 'status' => 413 ) );
		}
		wc_set_time_limit( 0 );
		$writer = new CF_Writer( (array) ( $body['options'] ?? array() ) );
		return $writer->run( $body['ops'] );
	}
}
