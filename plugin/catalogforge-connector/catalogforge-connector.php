<?php
/**
 * Plugin Name:       CatalogForge Connector
 * Description:       High-throughput, signed bridge between the CatalogForge desktop app and this WooCommerce store: bulk catalog export, bulk upserts through WooCommerce CRUD with deferred housekeeping, zero-CPU media ingestion, and theme-accurate live previews.
 * Version:           0.1.0
 * Requires at least: 6.2
 * Requires PHP:      7.4
 * Author:            CatalogForge
 * License:           GPL-2.0-or-later
 * Text Domain:       catalogforge
 * WC requires at least: 8.0
 *
 * @package CatalogForge
 */

defined( 'ABSPATH' ) || exit;

define( 'CATALOGFORGE_VERSION', '0.1.0' );
define( 'CATALOGFORGE_PROTOCOL', 1 );
define( 'CATALOGFORGE_DIR', __DIR__ );

require_once __DIR__ . '/includes/class-cf-auth.php';
require_once __DIR__ . '/includes/class-cf-serializer.php';
require_once __DIR__ . '/includes/class-cf-writer.php';
require_once __DIR__ . '/includes/class-cf-media.php';
require_once __DIR__ . '/includes/class-cf-preview.php';
require_once __DIR__ . '/includes/class-cf-api.php';
require_once __DIR__ . '/includes/class-cf-admin.php';

// Declare compatibility with HPOS. The connector never touches order storage for products.
add_action(
	'before_woocommerce_init',
	static function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
		}
	}
);

add_action( 'rest_api_init', array( 'CF_Api', 'register_routes' ) );
add_action( 'init', array( 'CF_Preview', 'init' ) );

if ( is_admin() ) {
	CF_Admin::init();
}
