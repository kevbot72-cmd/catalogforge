<?php
/**
 * Tools → StoreGenie Pro: create and revoke connection keys.
 *
 * @package StoreGeniePro
 */

defined( 'ABSPATH' ) || exit;

class SG_Admin {

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_post_storegenie_create_key', array( __CLASS__, 'create' ) );
		add_action( 'admin_post_storegenie_revoke_key', array( __CLASS__, 'revoke' ) );
	}

	public static function menu() {
		add_management_page( 'StoreGenie Pro', 'StoreGenie Pro', 'manage_woocommerce', 'storegenie', array( __CLASS__, 'render' ) );
	}

	public static function create() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'Not allowed.', 'storegenie' ) );
		}
		check_admin_referer( 'storegenie_create_key' );
		$label = isset( $_POST['label'] ) ? sanitize_text_field( wp_unslash( $_POST['label'] ) ) : '';
		$key   = SG_Auth::create_key( get_current_user_id(), $label ? $label : 'Desktop app' );
		// Show the secret exactly once.
		set_transient( 'sg_new_key_' . get_current_user_id(), SG_Auth::connection_string( $key['key'], $key['secret'] ), 120 );
		wp_safe_redirect( admin_url( 'tools.php?page=storegenie' ) );
		exit;
	}

	public static function revoke() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'Not allowed.', 'storegenie' ) );
		}
		check_admin_referer( 'storegenie_revoke_key' );
		SG_Auth::revoke_key( isset( $_POST['key'] ) ? sanitize_text_field( wp_unslash( $_POST['key'] ) ) : '' );
		wp_safe_redirect( admin_url( 'tools.php?page=storegenie' ) );
		exit;
	}

	public static function render() {
		$new = get_transient( 'sg_new_key_' . get_current_user_id() );
		delete_transient( 'sg_new_key_' . get_current_user_id() );
		?>
		<div class="wrap">
			<h1>StoreGenie Pro Connector</h1>
			<p>Create a connection key, then paste the connection string into <strong>StoreGenie Pro → Add store → Connector plugin</strong>.</p>
			<?php if ( $new ) : ?>
				<div class="notice notice-success"><p><strong>Copy this connection string now. It will not be shown again.</strong></p>
					<p><textarea readonly rows="3" style="width:100%;font-family:monospace" onclick="this.select()"><?php echo esc_textarea( $new ); ?></textarea></p></div>
			<?php endif; ?>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<?php wp_nonce_field( 'storegenie_create_key' ); ?>
				<input type="hidden" name="action" value="storegenie_create_key" />
				<input type="text" name="label" placeholder="Label, e.g. Office iMac" class="regular-text" />
				<?php submit_button( 'Create connection key', 'primary', 'submit', false ); ?>
			</form>
			<h2>Active keys</h2>
			<table class="widefat striped"><thead><tr><th>Key</th><th>Label</th><th>User</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>
			<?php foreach ( SG_Auth::get_keys() as $key => $k ) : $u = get_user_by( 'id', $k['user_id'] ); ?>
				<tr>
					<td><code><?php echo esc_html( $key ); ?></code></td>
					<td><?php echo esc_html( $k['label'] ); ?></td>
					<td><?php echo esc_html( $u ? $u->user_login : '—' ); ?></td>
					<td><?php echo esc_html( wp_date( 'Y-m-d H:i', $k['created'] ) ); ?></td>
					<td><?php echo ! empty( $k['last_used'] ) ? esc_html( human_time_diff( $k['last_used'] ) . ' ago' ) : '—'; ?></td>
					<td><form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
						<?php wp_nonce_field( 'storegenie_revoke_key' ); ?>
						<input type="hidden" name="action" value="storegenie_revoke_key" />
						<input type="hidden" name="key" value="<?php echo esc_attr( $key ); ?>" />
						<?php submit_button( 'Revoke', 'delete small', 'submit', false ); ?>
					</form></td>
				</tr>
			<?php endforeach; ?>
			</tbody></table>
		</div>
		<?php
	}
}
