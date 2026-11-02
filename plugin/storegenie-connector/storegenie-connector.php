<?php
/**
 * Plugin Name:       StoreGenie Pro Connector
 * Description:       High-throughput, signed bridge between the StoreGenie Pro desktop app and this WooCommerce store: bulk catalog export, bulk upserts through WooCommerce CRUD with deferred housekeeping, zero-CPU media ingestion, and theme-accurate live previews.
 * Version:           1.0.0
 * Requires at least: 6.2
 * Requires PHP:      7.4
 * Author:            StoreGenie Pro
 * License:           GPL-2.0-or-later
 * Text Domain:       storegenie
 * WC requires at least: 8.0
 *
 * @package StoreGeniePro
 */

defined( 'ABSPATH' ) || exit;

define( 'STOREGENIE_VERSION', '1.0.0' );
define( 'STOREGENIE_PROTOCOL', 1 );
define( 'STOREGENIE_DIR', __DIR__ );

require_once __DIR__ . '/includes/class-sg-migrate.php';
require_once __DIR__ . '/includes/class-sg-auth.php';
require_once __DIR__ . '/includes/class-sg-serializer.php';
require_once __DIR__ . '/includes/class-sg-writer.php';
require_once __DIR__ . '/includes/class-sg-media.php';
require_once __DIR__ . '/includes/class-sg-preview.php';
require_once __DIR__ . '/includes/class-sg-api.php';
require_once __DIR__ . '/includes/class-sg-admin.php';

// Declare compatibility with HPOS. The connector never touches order storage for products.
add_action(
	'before_woocommerce_init',
	static function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
		}
	}
);

SG_Migrate::init();
add_action( 'rest_api_init', array( 'SG_Api', 'register_routes' ) );
add_action( 'init', array( 'SG_Preview', 'init' ) );
add_action( 'init', array( 'SG_Media', 'maybe_upgrade' ), 20 );

if ( is_admin() ) {
	SG_Admin::init();
}
