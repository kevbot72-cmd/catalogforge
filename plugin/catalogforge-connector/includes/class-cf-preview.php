<?php
/**
 * Theme-accurate live preview of unsaved product edits.
 *
 * The app POSTs a draft to /preview and receives a short-lived URL. Loading that URL renders the
 * store's real single-product template (theme, blocks, plugins) with the draft values overlaid
 * in memory. Nothing is written to the product.
 *
 * @package CatalogForge
 */

defined( 'ABSPATH' ) || exit;

class CF_Preview {

	const TTL = 900;

	/** @var array|null */
	private static $draft = null;
	private static $target = 0;

	public static function create( $request ) {
		$body = CF_Auth::json_body( $request );
		$id   = (int) ( $body['product_id'] ?? 0 );
		if ( $id && ! wc_get_product( $id ) ) {
			return new WP_Error( 'cf_missing', 'Product not found.', array( 'status' => 404 ) );
		}
		if ( ! $id ) {
			$id = self::placeholder_id();
		}
		$token = wp_generate_password( 32, false, false );
		set_transient(
			'cf_pv_' . $token,
			array(
				'product_id' => $id,
				'data'       => (array) ( $body['data'] ?? array() ),
			),
			self::TTL
		);
		$url = add_query_arg(
			array(
				'post_type'  => 'product',
				'p'          => $id,
				'cf_preview' => $token,
			),
			home_url( '/' )
		);
		return array( 'url' => $url, 'expires_in' => self::TTL, 'product_id' => $id );
	}

	/**
	 * A hidden draft product used to preview products that do not exist yet.
	 */
	private static function placeholder_id() {
		$id = (int) get_option( 'catalogforge_preview_placeholder' );
		if ( $id && 'product' === get_post_type( $id ) ) {
			return $id;
		}
		$p = new WC_Product_Simple();
		$p->set_name( 'CatalogForge preview placeholder' );
		$p->set_status( 'draft' );
		$p->set_catalog_visibility( 'hidden' );
		$p->update_meta_data( '_cf_preview_placeholder', 1 );
		$id = $p->save();
		update_option( 'catalogforge_preview_placeholder', $id, false );
		return $id;
	}

	public static function init() {
		if ( empty( $_GET['cf_preview'] ) || is_admin() ) { // phpcs:ignore WordPress.Security.NonceVerification
			return;
		}
		$token = preg_replace( '/[^A-Za-z0-9]/', '', (string) wp_unslash( $_GET['cf_preview'] ) ); // phpcs:ignore WordPress.Security.NonceVerification
		$state = get_transient( 'cf_pv_' . $token );
		if ( ! is_array( $state ) ) {
			return;
		}
		self::$draft  = $state['data'];
		self::$target = (int) $state['product_id'];

		add_action( 'pre_get_posts', array( __CLASS__, 'allow_unpublished' ) );
		add_filter( 'posts_results', array( __CLASS__, 'posts_results' ), 10, 2 );
		add_filter( 'get_the_terms', array( __CLASS__, 'terms' ), 10, 3 );
		add_action( 'wp_footer', array( __CLASS__, 'badge' ) );
		add_action( 'template_redirect', array( __CLASS__, 'headers' ), 99 );
		add_filter( 'wp_robots', 'wp_robots_no_robots' );
		add_filter( 'redirect_canonical', '__return_false' );
		// Stores under construction (WooCommerce "coming soon" mode) must still preview for the merchant.
		add_filter( 'woocommerce_coming_soon_exclude', '__return_true' );

		$props = array(
			'name', 'sku', 'regular_price', 'sale_price', 'description', 'short_description',
			'stock_status', 'stock_quantity', 'weight', 'length', 'width', 'height', 'image_id',
			'gallery_image_ids',
		);
		foreach ( $props as $prop ) {
			add_filter( 'woocommerce_product_get_' . $prop, array( __CLASS__, 'prop' ), 99, 2 );
		}
		add_filter( 'woocommerce_product_get_price', array( __CLASS__, 'price' ), 99, 2 );
		add_filter( 'woocommerce_product_is_on_sale', array( __CLASS__, 'on_sale' ), 99, 2 );
	}

	private static function is_target( $product ) {
		return $product instanceof WC_Product && $product->get_id() === self::$target;
	}

	private static function draft( $key ) {
		$map = array( 'gallery_image_ids' => 'gallery_ids' );
		$key = $map[ $key ] ?? $key;
		return array_key_exists( $key, self::$draft ) ? array( true, self::$draft[ $key ] ) : array( false, null );
	}

	public static function prop( $value, $product ) {
		if ( ! self::is_target( $product ) ) {
			return $value;
		}
		$prop             = substr( current_filter(), strlen( 'woocommerce_product_get_' ) );
		list( $has, $v ) = self::draft( $prop );
		return $has ? $v : $value;
	}

	public static function price( $value, $product ) {
		if ( ! self::is_target( $product ) ) {
			return $value;
		}
		list( $has_sale, $sale ) = self::draft( 'sale_price' );
		list( $has_reg, $reg )   = self::draft( 'regular_price' );
		$sale = $has_sale ? $sale : $product->get_sale_price( 'edit' );
		$reg  = $has_reg ? $reg : $product->get_regular_price( 'edit' );
		return ( '' !== (string) $sale && null !== $sale ) ? $sale : $reg;
	}

	public static function on_sale( $on_sale, $product ) {
		if ( ! self::is_target( $product ) ) {
			return $on_sale;
		}
		$sale = $product->get_sale_price();
		return '' !== (string) $sale && (float) $sale < (float) $product->get_regular_price();
	}

	/**
	 * Lets the main query load the (draft) target so unsaved/new products can be previewed.
	 */
	public static function allow_unpublished( $query ) {
		if ( $query->is_main_query() && (int) $query->get( 'p' ) === self::$target ) {
			$query->set( 'post_status', array( 'publish', 'draft', 'pending', 'private', 'future' ) );
		}
	}

	public static function posts_results( $posts, $query ) {
		foreach ( $posts as $post ) {
			if ( (int) $post->ID !== self::$target ) {
				continue;
			}
			$post->post_status = 'publish';
			if ( array_key_exists( 'name', self::$draft ) ) {
				$post->post_title = (string) self::$draft['name'];
			}
			if ( array_key_exists( 'description', self::$draft ) ) {
				$post->post_content = (string) self::$draft['description'];
			}
			if ( array_key_exists( 'short_description', self::$draft ) ) {
				$post->post_excerpt = (string) self::$draft['short_description'];
			}
		}
		return $posts;
	}

	public static function terms( $terms, $post_id, $taxonomy ) {
		if ( (int) $post_id !== self::$target || 'product_cat' !== $taxonomy || ! array_key_exists( 'category_ids', self::$draft ) ) {
			return $terms;
		}
		$out = array();
		foreach ( (array) self::$draft['category_ids'] as $id ) {
			$t = get_term( (int) $id, 'product_cat' );
			if ( $t && ! is_wp_error( $t ) ) {
				$out[] = $t;
			}
		}
		return $out;
	}

	public static function headers() {
		nocache_headers();
		if ( function_exists( 'header_remove' ) && ! headers_sent() ) {
			header_remove( 'X-Frame-Options' );
		}
	}

	public static function badge() {
		echo '<div style="position:fixed;z-index:99999;bottom:12px;right:12px;padding:6px 10px;border-radius:6px;background:#111827;color:#fff;font:600 12px/1.4 system-ui,sans-serif;opacity:.85;pointer-events:none">Preview · unsaved changes</div>';
	}
}
