<?php
/**
 * Request signing.
 *
 * Every request carries:
 *   X-CF-Key        key id
 *   X-CF-Timestamp  unix seconds (must be within ±300s of server time)
 *   X-CF-Nonce      random string, single use within the replay window
 *   X-CF-Signature  hex HMAC-SHA256(secret, canonical string)
 *
 * Canonical string (lines joined with "\n"):
 *   timestamp, nonce, METHOD, route, canonical query, sha256(body), sha256(X-CF-Manifest header)
 *
 * Keys are stored as a JSON document in the `catalogforge_keys` option (JSON rather than a
 * PHP-serialized array so the desktop app can provision a key directly in a Local site's
 * database without a PHP runtime).
 *
 * @package CatalogForge
 */

defined( 'ABSPATH' ) || exit;

class CF_Auth {

	const OPTION        = 'catalogforge_keys';
	const WINDOW        = 300;
	const NONCE_TTL     = 600;

	/**
	 * @return array<string,array{secret:string,user_id:int,label:string,created:int,last_used?:int}>
	 */
	public static function get_keys() {
		$raw  = get_option( self::OPTION, '{}' );
		$keys = is_array( $raw ) ? $raw : json_decode( (string) $raw, true );
		return is_array( $keys ) ? $keys : array();
	}

	public static function save_keys( array $keys ) {
		update_option( self::OPTION, wp_json_encode( (object) $keys ), false );
	}

	/**
	 * @return array{key:string,secret:string}
	 */
	public static function create_key( $user_id, $label ) {
		$keys            = self::get_keys();
		$key             = 'cf_' . strtolower( wp_generate_password( 16, false, false ) );
		$secret          = bin2hex( random_bytes( 32 ) );
		$keys[ $key ]    = array(
			'secret'  => $secret,
			'user_id' => (int) $user_id,
			'label'   => sanitize_text_field( $label ),
			'created' => time(),
		);
		self::save_keys( $keys );
		return array( 'key' => $key, 'secret' => $secret );
	}

	public static function revoke_key( $key ) {
		$keys = self::get_keys();
		unset( $keys[ $key ] );
		self::save_keys( $keys );
	}

	/**
	 * Connection string the user pastes into the app: cf1.<base64url(json)>.
	 */
	public static function connection_string( $key, $secret ) {
		$payload = wp_json_encode(
			array(
				'v'      => CATALOGFORGE_PROTOCOL,
				'url'    => home_url( '/' ),
				'rest'   => rest_url(),
				'key'    => $key,
				'secret' => $secret,
			)
		);
		return 'cf1.' . rtrim( strtr( base64_encode( $payload ), '+/', '-_' ), '=' );
	}

	public static function canonical_query( array $params ) {
		unset( $params['rest_route'] );
		ksort( $params, SORT_STRING );
		$parts = array();
		foreach ( $params as $k => $v ) {
			if ( is_array( $v ) ) {
				$v = implode( ',', $v );
			}
			$parts[] = rawurlencode( (string) $k ) . '=' . rawurlencode( (string) $v );
		}
		return implode( '&', $parts );
	}

	public static function canonical_string( $ts, $nonce, $method, $route, $query, $body, $manifest ) {
		return implode(
			"\n",
			array(
				(string) $ts,
				(string) $nonce,
				strtoupper( $method ),
				$route,
				$query,
				hash( 'sha256', (string) $body ),
				hash( 'sha256', (string) $manifest ),
			)
		);
	}

	/**
	 * REST permission callback.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return true|WP_Error
	 */
	public static function check( $request ) {
		$key   = (string) $request->get_header( 'x_cf_key' );
		$ts    = (string) $request->get_header( 'x_cf_timestamp' );
		$nonce = (string) $request->get_header( 'x_cf_nonce' );
		$sig   = (string) $request->get_header( 'x_cf_signature' );

		if ( '' === $key || '' === $ts || '' === $nonce || '' === $sig ) {
			return new WP_Error( 'cf_unsigned', 'Missing CatalogForge signature headers.', array( 'status' => 401 ) );
		}
		$keys = self::get_keys();
		if ( empty( $keys[ $key ]['secret'] ) ) {
			return new WP_Error( 'cf_bad_key', 'Unknown or revoked key.', array( 'status' => 401 ) );
		}
		if ( ! ctype_digit( $ts ) || abs( time() - (int) $ts ) > self::WINDOW ) {
			return new WP_Error( 'cf_clock', 'Timestamp outside the allowed window; check the computer clock.', array( 'status' => 401, 'server_time' => time() ) );
		}
		if ( ! preg_match( '/^[A-Za-z0-9_-]{8,64}$/', $nonce ) ) {
			return new WP_Error( 'cf_nonce', 'Malformed nonce.', array( 'status' => 401 ) );
		}

		$manifest  = (string) $request->get_header( 'x_cf_manifest' );
		$canonical = self::canonical_string(
			$ts,
			$nonce,
			$request->get_method(),
			$request->get_route(),
			self::canonical_query( $request->get_query_params() ),
			self::raw_body( $request ),
			$manifest
		);
		$expected  = hash_hmac( 'sha256', $canonical, $keys[ $key ]['secret'] );
		if ( ! hash_equals( $expected, strtolower( $sig ) ) ) {
			return new WP_Error( 'cf_signature', 'Signature mismatch.', array( 'status' => 401 ) );
		}

		$nonce_key = 'cf_n_' . md5( $key . $nonce );
		if ( get_transient( $nonce_key ) ) {
			return new WP_Error( 'cf_replay', 'Nonce already used.', array( 'status' => 401 ) );
		}
		set_transient( $nonce_key, 1, self::NONCE_TTL );

		$user_id = (int) $keys[ $key ]['user_id'];
		$user    = get_user_by( 'id', $user_id );
		if ( ! $user || ! user_can( $user, 'manage_woocommerce' ) ) {
			return new WP_Error( 'cf_user', 'The user bound to this key can no longer manage WooCommerce.', array( 'status' => 403 ) );
		}
		// Act as the bound user so capability checks, kses rules and authorship behave as in wp-admin.
		wp_set_current_user( $user_id );

		if ( empty( $keys[ $key ]['last_used'] ) || time() - (int) $keys[ $key ]['last_used'] > 300 ) {
			$keys[ $key ]['last_used'] = time();
			self::save_keys( $keys );
		}
		return true;
	}

	/**
	 * Raw request body, transparently gunzipped when the client sent X-CF-Encoding: gzip.
	 * The signature is computed over the bytes on the wire.
	 */
	public static function raw_body( $request ) {
		return (string) $request->get_body();
	}

	/**
	 * Decoded JSON body (handles gzip).
	 *
	 * @return array
	 */
	public static function json_body( $request ) {
		$body = self::raw_body( $request );
		if ( 'gzip' === strtolower( (string) $request->get_header( 'x_cf_encoding' ) ) ) {
			$body = gzdecode( $body );
			if ( false === $body ) {
				return array();
			}
		}
		$data = json_decode( $body, true );
		return is_array( $data ) ? $data : array();
	}
}
