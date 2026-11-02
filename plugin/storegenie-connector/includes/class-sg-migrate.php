<?php
/**
 * One-time move from the CatalogForge Connector (the plugin's name before StoreGenie Pro).
 *
 * Copies the connection keys and settings to their new option names, renames the plugin's own
 * product, category and image meta keys (_cf_* → _sg_*), and switches the old plugin off so the
 * two don't run side by side. Existing connections keep working: the same keys are carried over.
 *
 * @package StoreGeniePro
 */

defined( 'ABSPATH' ) || exit;

class SG_Migrate {

	const DONE        = 'storegenie_migrated';
	const OLD_PLUGIN  = 'catalogforge-connector/catalogforge-connector.php';
	const POST_META   = array( 'guid', 'seo_title', 'seo_description', 'focus_keyword', 'sha256', 'source_url', 'source', 'preview_placeholder' );
	const TERM_META   = array( 'banner_id', 'seo_title', 'seo_description' );

	public static function init() {
		add_action( 'plugins_loaded', array( __CLASS__, 'maybe_run' ), 5 );
		add_action( 'admin_init', array( __CLASS__, 'retire_old_plugin' ) );
	}

	public static function maybe_run() {
		if ( get_option( self::DONE ) ) {
			return;
		}
		self::run();
	}

	/** Safe to run more than once: options merge, and meta renames only touch old keys. */
	public static function run() {
		global $wpdb;

		// Connection keys: merge, so keys made by either plugin keep working.
		$old = json_decode( (string) get_option( 'catalogforge_keys', '{}' ), true );
		$new = json_decode( (string) get_option( 'storegenie_keys', '{}' ), true );
		if ( is_array( $old ) && $old ) {
			$merged = ( is_array( $new ) ? $new : array() ) + $old;
			update_option( 'storegenie_keys', wp_json_encode( (object) $merged ), false );
		}
		foreach ( array( 'preview_placeholder', 'schema' ) as $name ) {
			$value = get_option( 'catalogforge_' . $name, null );
			if ( null !== $value && false === get_option( 'storegenie_' . $name, false ) ) {
				update_option( 'storegenie_' . $name, $value, 'schema' === $name );
			}
		}

		foreach ( self::POST_META as $k ) {
			$wpdb->update( $wpdb->postmeta, array( 'meta_key' => '_sg_' . $k ), array( 'meta_key' => '_cf_' . $k ) ); // phpcs:ignore WordPress.DB.SlowDBQuery
		}
		foreach ( self::TERM_META as $k ) {
			$wpdb->update( $wpdb->termmeta, array( 'meta_key' => '_sg_' . $k ), array( 'meta_key' => '_cf_' . $k ) ); // phpcs:ignore WordPress.DB.SlowDBQuery
		}
		wp_cache_flush();
		update_option( self::DONE, STOREGENIE_VERSION, true );
	}

	/** The old CatalogForge Connector is replaced by this plugin: switch it off (it can then be deleted). */
	public static function retire_old_plugin() {
		if ( ! function_exists( 'is_plugin_active' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		if ( is_plugin_active( self::OLD_PLUGIN ) ) {
			deactivate_plugins( self::OLD_PLUGIN, true );
			// Anything the old plugin wrote since the first run is carried over too.
			self::run();
			add_action(
				'admin_notices',
				static function () {
					echo '<div class="notice notice-info is-dismissible"><p>' . esc_html__( 'StoreGenie Pro Connector replaced the CatalogForge Connector and switched it off. Your connection keys were kept; you can delete the old plugin.', 'storegenie' ) . '</p></div>';
				}
			);
		}
	}
}
