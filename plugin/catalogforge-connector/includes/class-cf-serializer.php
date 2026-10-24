<?php
/**
 * Converts WooCommerce objects to the CatalogForge wire format (and holds the shared field lists).
 *
 * @package CatalogForge
 */

defined( 'ABSPATH' ) || exit;

class CF_Serializer {

	/**
	 * SEO fields are normalised so the app has one column regardless of the SEO plugin in use.
	 * Writes go to every SEO plugin that is active.
	 */
	public static function seo_meta_map() {
		$map = array();
		if ( defined( 'WPSEO_VERSION' ) ) {
			$map['seo_title']       = array_merge( $map['seo_title'] ?? array(), array( '_yoast_wpseo_title' ) );
			$map['seo_description'] = array_merge( $map['seo_description'] ?? array(), array( '_yoast_wpseo_metadesc' ) );
			$map['focus_keyword']   = array_merge( $map['focus_keyword'] ?? array(), array( '_yoast_wpseo_focuskw' ) );
		}
		if ( defined( 'RANK_MATH_VERSION' ) ) {
			$map['seo_title']       = array_merge( $map['seo_title'] ?? array(), array( 'rank_math_title' ) );
			$map['seo_description'] = array_merge( $map['seo_description'] ?? array(), array( 'rank_math_description' ) );
			$map['focus_keyword']   = array_merge( $map['focus_keyword'] ?? array(), array( 'rank_math_focus_keyword' ) );
		}
		if ( empty( $map ) ) {
			// No SEO plugin: keep values in our own keys so nothing typed in the app is lost.
			$map = array(
				'seo_title'       => array( '_cf_seo_title' ),
				'seo_description' => array( '_cf_seo_description' ),
				'focus_keyword'   => array( '_cf_focus_keyword' ),
			);
		}
		return $map;
	}

	/**
	 * @param WC_Product $p         Product or variation.
	 * @param string[]   $meta_keys Extra meta keys requested by the client.
	 * @return array
	 */
	public static function product( $p, array $meta_keys = array() ) {
		$is_variation = $p->is_type( 'variation' );
		$shipping     = $p->get_shipping_class_id( 'edit' );
		$shipping_obj = $shipping ? get_term( $shipping, 'product_shipping_class' ) : null;

		$out = array(
			'id'                 => $p->get_id(),
			'parent_id'          => $p->get_parent_id( 'edit' ),
			'type'               => $p->get_type(),
			'status'             => $p->get_status( 'edit' ),
			'name'               => $p->get_name( 'edit' ),
			'slug'               => $is_variation ? '' : $p->get_slug( 'edit' ),
			'sku'                => $p->get_sku( 'edit' ),
			'global_unique_id'   => method_exists( $p, 'get_global_unique_id' ) ? $p->get_global_unique_id( 'edit' ) : '',
			'regular_price'      => (string) $p->get_regular_price( 'edit' ),
			'sale_price'         => (string) $p->get_sale_price( 'edit' ),
			'date_on_sale_from'  => self::date( $p->get_date_on_sale_from( 'edit' ) ),
			'date_on_sale_to'    => self::date( $p->get_date_on_sale_to( 'edit' ) ),
			'manage_stock'       => $p->get_manage_stock( 'edit' ) === true || 'yes' === $p->get_manage_stock( 'edit' ),
			'stock_quantity'     => null === $p->get_stock_quantity( 'edit' ) ? null : (int) $p->get_stock_quantity( 'edit' ),
			'stock_status'       => $p->get_stock_status( 'edit' ),
			'backorders'         => $p->get_backorders( 'edit' ),
			'weight'             => (string) $p->get_weight( 'edit' ),
			'length'             => (string) $p->get_length( 'edit' ),
			'width'              => (string) $p->get_width( 'edit' ),
			'height'             => (string) $p->get_height( 'edit' ),
			'shipping_class'     => ( $shipping_obj && ! is_wp_error( $shipping_obj ) ) ? $shipping_obj->slug : '',
			'tax_status'         => $p->get_tax_status( 'edit' ),
			'tax_class'          => $p->get_tax_class( 'edit' ),
			'description'        => $p->get_description( 'edit' ),
			'short_description'  => $is_variation ? '' : $p->get_short_description( 'edit' ),
			'menu_order'         => (int) $p->get_menu_order( 'edit' ),
			'featured'           => $is_variation ? false : (bool) $p->get_featured( 'edit' ),
			'catalog_visibility' => $is_variation ? 'visible' : $p->get_catalog_visibility( 'edit' ),
			'virtual'            => (bool) $p->get_virtual( 'edit' ),
			'downloadable'       => (bool) $p->get_downloadable( 'edit' ),
			'category_ids'       => $is_variation ? array() : array_map( 'intval', $p->get_category_ids( 'edit' ) ),
			'tags'               => $is_variation ? array() : self::tag_names( $p->get_tag_ids( 'edit' ) ),
			'attributes'         => $is_variation ? array() : self::attributes( $p ),
			'variation_attributes' => $is_variation ? (object) $p->get_attributes( 'edit' ) : (object) array(),
			'image_id'           => (int) $p->get_image_id( 'edit' ),
			'gallery_ids'        => $is_variation ? array() : array_map( 'intval', $p->get_gallery_image_ids( 'edit' ) ),
			'external_url'       => $p->is_type( 'external' ) ? $p->get_product_url( 'edit' ) : '',
			'button_text'        => $p->is_type( 'external' ) ? $p->get_button_text( 'edit' ) : '',
			'permalink'          => $is_variation ? '' : get_permalink( $p->get_id() ),
			'date_created_gmt'   => self::date( $p->get_date_created( 'edit' ) ),
			'date_modified_gmt'  => self::date( $p->get_date_modified( 'edit' ) ),
		);

		foreach ( self::seo_meta_map() as $field => $keys ) {
			$out[ $field ] = $is_variation ? '' : (string) $p->get_meta( $keys[0], true, 'edit' );
		}

		if ( $meta_keys ) {
			$meta = array();
			foreach ( $meta_keys as $k ) {
				$meta[ $k ] = $p->get_meta( $k, true, 'edit' );
			}
			$out['meta'] = (object) $meta;
		}
		return $out;
	}

	private static function date( $d ) {
		return $d instanceof WC_DateTime ? gmdate( 'Y-m-d\TH:i:s\Z', $d->getTimestamp() ) : null;
	}

	private static function tag_names( array $ids ) {
		$names = array();
		foreach ( $ids as $id ) {
			$t = get_term( $id, 'product_tag' );
			if ( $t && ! is_wp_error( $t ) ) {
				$names[] = $t->name;
			}
		}
		return $names;
	}

	private static function attributes( $p ) {
		$out = array();
		foreach ( $p->get_attributes( 'edit' ) as $attr ) {
			if ( ! $attr instanceof WC_Product_Attribute ) {
				continue;
			}
			if ( $attr->is_taxonomy() ) {
				$options = array();
				foreach ( $attr->get_options() as $term_id ) {
					$t = get_term( $term_id, $attr->get_name() );
					if ( $t && ! is_wp_error( $t ) ) {
						$options[] = $t->name;
					}
				}
			} else {
				$options = array_values( $attr->get_options() );
			}
			$out[] = array(
				'name'      => $attr->is_taxonomy() ? wc_attribute_label( $attr->get_name() ) : $attr->get_name(),
				'taxonomy'  => $attr->is_taxonomy() ? $attr->get_name() : '',
				'options'   => $options,
				'visible'   => (bool) $attr->get_visible(),
				'variation' => (bool) $attr->get_variation(),
				'position'  => (int) $attr->get_position(),
			);
		}
		return $out;
	}

	/**
	 * @param WP_Term  $t         Term.
	 * @param int|null $raw_count Stored count. WooCommerce filters term counts to include child
	 *                            categories; the app aggregates itself, so it wants the raw value.
	 */
	public static function category( WP_Term $t, $raw_count = null ) {
		if ( null === $raw_count ) {
			global $wpdb;
			$raw_count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT count FROM {$wpdb->term_taxonomy} WHERE term_taxonomy_id = %d", $t->term_taxonomy_id ) );
		}
		$out = array(
			'id'           => $t->term_id,
			'parent'       => $t->parent,
			'name'         => $t->name,
			'slug'         => $t->slug,
			'description'  => $t->description,
			'count'        => (int) $raw_count,
			'display_type' => (string) get_term_meta( $t->term_id, 'display_type', true ),
			'image_id'     => (int) get_term_meta( $t->term_id, 'thumbnail_id', true ),
			'banner_id'    => (int) get_term_meta( $t->term_id, '_cf_banner_id', true ),
			'menu_order'   => (int) get_term_meta( $t->term_id, 'order', true ),
		);
		$seo_title = '';
		$seo_desc  = '';
		if ( defined( 'RANK_MATH_VERSION' ) ) {
			$seo_title = (string) get_term_meta( $t->term_id, 'rank_math_title', true );
			$seo_desc  = (string) get_term_meta( $t->term_id, 'rank_math_description', true );
		} else {
			$seo_title = (string) get_term_meta( $t->term_id, '_cf_seo_title', true );
			$seo_desc  = (string) get_term_meta( $t->term_id, '_cf_seo_description', true );
		}
		$out['seo_title']       = $seo_title;
		$out['seo_description'] = $seo_desc;
		return $out;
	}

	public static function media( $id ) {
		$post = get_post( $id );
		if ( ! $post || 'attachment' !== $post->post_type ) {
			return null;
		}
		$meta  = wp_get_attachment_metadata( $id );
		$thumb = wp_get_attachment_image_src( $id, 'thumbnail' );
		$med   = wp_get_attachment_image_src( $id, 'medium' );
		return array(
			'id'        => (int) $id,
			'url'       => wp_get_attachment_url( $id ),
			'thumb_url' => $thumb ? $thumb[0] : wp_get_attachment_url( $id ),
			'medium_url' => $med ? $med[0] : wp_get_attachment_url( $id ),
			'alt'       => (string) get_post_meta( $id, '_wp_attachment_image_alt', true ),
			'title'     => $post->post_title,
			'filename'  => wp_basename( (string) get_attached_file( $id ) ),
			'mime'      => $post->post_mime_type,
			'width'     => isset( $meta['width'] ) ? (int) $meta['width'] : 0,
			'height'    => isset( $meta['height'] ) ? (int) $meta['height'] : 0,
			'sha256'    => (string) get_post_meta( $id, '_cf_sha256', true ),
			'parent_id' => (int) $post->post_parent,
		);
	}
}
