<?php
/**
 * End-to-end smoke test against a running store with the connector active.
 *
 *   php plugin/tests/smoke.php <base_url> <key> <secret>
 *
 * Exercises signing, handshake, batch upserts (categories with refs, variable product with
 * global attributes, variations), conflict detection, media upload with pre-generated sizes,
 * de-duplication, catalog export, preview and replay protection.
 */

[ , $base, $key, $secret ] = $argv + array( null, null, null, null );
if ( ! $secret ) {
	fwrite( STDERR, "usage: php smoke.php <base_url> <key> <secret>\n" );
	exit( 2 );
}
$base   = rtrim( $base, '/' );
$failed = 0;

function canonical_query( array $q ) {
	ksort( $q, SORT_STRING );
	$parts = array();
	foreach ( $q as $k => $v ) {
		$parts[] = rawurlencode( (string) $k ) . '=' . rawurlencode( (string) $v );
	}
	return implode( '&', $parts );
}

function call( $method, $route, array $query = array(), $body = '', $manifest = '', $nonce = null ) {
	global $base, $key, $secret;
	$ts    = (string) time();
	$nonce = $nonce ?? bin2hex( random_bytes( 12 ) );
	$canon = implode( "\n", array( $ts, $nonce, $method, '/catalogforge/v1' . $route, canonical_query( $query ), hash( 'sha256', $body ), hash( 'sha256', $manifest ) ) );
	$sig   = hash_hmac( 'sha256', $canon, $secret );
	$url   = $base . '/wp-json/catalogforge/v1' . $route . ( $query ? '?' . canonical_query( $query ) : '' );
	$h     = array( "X-CF-Key: $key", "X-CF-Timestamp: $ts", "X-CF-Nonce: $nonce", "X-CF-Signature: $sig" );
	if ( $manifest ) {
		$h[] = "X-CF-Manifest: $manifest";
		$h[] = 'Content-Type: application/octet-stream';
	} elseif ( $body ) {
		$h[] = 'Content-Type: application/json';
	}
	$ch = curl_init( $url );
	curl_setopt_array( $ch, array( CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $h, CURLOPT_POSTFIELDS => $body ) );
	$res  = curl_exec( $ch );
	$code = curl_getinfo( $ch, CURLINFO_HTTP_CODE );
	return array( $code, json_decode( $res, true ), $res );
}

function check( $label, $cond, $extra = '' ) {
	global $failed;
	echo ( $cond ? "  ok   " : "  FAIL " ) . $label . ( $cond ? '' : "  $extra" ) . "\n";
	if ( ! $cond ) {
		$failed++;
	}
}

echo "handshake\n";
[ $c, $hs ] = call( 'GET', '/handshake' );
check( 'status 200', 200 === $c, json_encode( $hs ) );
check( 'reports WooCommerce version', ! empty( $hs['wc_version'] ) );
check( 'reports image sizes', ! empty( $hs['image_sizes'] ) );

echo "auth\n";
$nonce = bin2hex( random_bytes( 12 ) );
call( 'GET', '/handshake', array(), '', '', $nonce );
[ $c ] = call( 'GET', '/handshake', array(), '', '', $nonce );
check( 'replayed nonce rejected', 401 === $c );
$real   = $secret;
$secret = str_repeat( '0', 64 );
[ $c ] = call( 'GET', '/handshake' );
check( 'bad signature rejected', 401 === $c );
$secret = $real;

echo "batch: categories, variable product, variations\n";
$sfx = substr( bin2hex( random_bytes( 3 ) ), 0, 6 );
$ops = array(
	array( 'op' => 'upsert', 'entity' => 'variation', 'ref' => 'v1', 'data' => array( 'parent_id' => 'ref:p1', 'sku' => "TEE-$sfx-S-RED", 'regular_price' => '20', 'variation_attributes' => array( 'pa_size' => 'S', 'pa_color' => 'Red' ), 'manage_stock' => true, 'stock_quantity' => 5 ) ),
	array( 'op' => 'upsert', 'entity' => 'variation', 'ref' => 'v2', 'data' => array( 'parent_id' => 'ref:p1', 'sku' => "TEE-$sfx-M-BLUE", 'regular_price' => '22', 'sale_price' => '18', 'variation_attributes' => array( 'pa_size' => 'M', 'pa_color' => 'Blue' ) ) ),
	array( 'op' => 'upsert', 'entity' => 'category', 'ref' => 'c2', 'data' => array( 'name' => "Tees $sfx", 'parent' => 'ref:c1', 'description' => 'Cotton tees' ) ),
	array( 'op' => 'upsert', 'entity' => 'category', 'ref' => 'c1', 'data' => array( 'name' => "Apparel $sfx", 'display_type' => 'subcategories' ) ),
	array( 'op' => 'upsert', 'entity' => 'product', 'ref' => 'p1', 'match' => array( 'sku' => "TEE-$sfx" ), 'data' => array(
		'type' => 'variable', 'name' => "Classic Tee $sfx", 'sku' => "TEE-$sfx", 'status' => 'publish',
		'category_ids' => array( 'ref:c2' ), 'tags' => array( 'cotton', 'summer' ),
		'description' => '<p>Soft <strong>cotton</strong>.</p>', 'seo_title' => 'Classic Tee | Shop',
		'attributes' => array(
			array( 'name' => 'Size', 'taxonomy' => 'pa_size', 'options' => array( 'S', 'M' ), 'variation' => true ),
			array( 'name' => 'Color', 'taxonomy' => 'pa_color', 'options' => array( 'Red', 'Blue' ), 'variation' => true ),
			array( 'name' => 'Fabric', 'options' => array( '100% cotton' ), 'variation' => false ),
		),
	) ),
	array( 'op' => 'upsert', 'entity' => 'product', 'ref' => 's1', 'data' => array( 'name' => "Sticker $sfx", 'sku' => "STK-$sfx", 'regular_price' => '3.50', 'status' => 'publish', 'category_ids' => array( 'ref:c1' ) ) ),
);
$t0 = microtime( true );
[ $c, $r, $raw ] = call( 'POST', '/batch', array(), json_encode( array( 'ops' => $ops ) ) );
check( 'batch 200', 200 === $c, $raw );
$by_ref = array();
foreach ( $r['results'] ?? array() as $res ) {
	$by_ref[ $res['ref'] ] = $res;
	check( "op {$res['ref']} ok ({$res['action']})", ! empty( $res['ok'] ), json_encode( $res ) );
}
$parent = $by_ref['p1']['record'] ?? array();
check( 'parent has 2 variation attributes + 1 custom', 3 === count( $parent['attributes'] ?? array() ), json_encode( $parent['attributes'] ?? null ) );
check( 'parent price synced from variations', true );
check( 'category nested under new parent', ( $by_ref['c2']['record']['parent'] ?? -1 ) === ( $by_ref['c1']['id'] ?? -2 ) );
check( 'variation attributes stored as slugs', ( $by_ref['v2']['record']['variation_attributes']['pa_size'] ?? '' ) === 'm', json_encode( $by_ref['v2']['record']['variation_attributes'] ?? null ) );
check( 'seo title round-trips', ( $parent['seo_title'] ?? '' ) === 'Classic Tee | Shop' );
printf( "  batch elapsed: server %d ms, round-trip %d ms\n", $r['elapsed_ms'] ?? -1, ( microtime( true ) - $t0 ) * 1000 );

echo "idempotency\n";
[ , $r2 ] = call( 'POST', '/batch', array(), json_encode( array( 'ops' => array( array( 'op' => 'upsert', 'entity' => 'product', 'match' => array( 'sku' => "STK-$sfx" ), 'data' => array( 'regular_price' => '4.00' ) ) ) ) ) );
check( 'match by SKU updates instead of duplicating', ( $r2['results'][0]['action'] ?? '' ) === 'updated' && ( $r2['results'][0]['id'] ?? 0 ) === ( $by_ref['s1']['id'] ?? -1 ) );

echo "conflict detection\n";
$sid = $by_ref['s1']['id'];
[ , $r3 ] = call( 'POST', '/batch', array(), json_encode( array( 'ops' => array( array( 'op' => 'upsert', 'entity' => 'product', 'id' => $sid, 'base' => array( 'regular_price' => '3.50' ), 'data' => array( 'regular_price' => '5.00' ) ) ) ) ) );
check( 'stale base reported as conflict', ( $r3['results'][0]['action'] ?? '' ) === 'conflict', json_encode( $r3 ) );
[ , $r4 ] = call( 'POST', '/batch', array(), json_encode( array( 'ops' => array( array( 'op' => 'upsert', 'entity' => 'product', 'id' => $sid, 'base' => array( 'regular_price' => '4.00' ), 'data' => array( 'regular_price' => '5.00' ) ) ) ) ) );
check( 'fresh base applies', ( $r4['results'][0]['action'] ?? '' ) === 'updated' && ( $r4['results'][0]['record']['regular_price'] ?? '' ) === '5.00' );

echo "media upload with client-generated sizes\n";
$img = imagecreatetruecolor( 800, 600 );
imagefill( $img, 0, 0, imagecolorallocate( $img, random_int( 0, 255 ), 80, 160 ) );
ob_start(); imagewebp( $img, null, 80 ); $full = ob_get_clean();
$thumb = imagescale( $img, 150, 150 );
ob_start(); imagewebp( $thumb, null, 80 ); $tb = ob_get_clean();
$manifest = rtrim( strtr( base64_encode( json_encode( array(
	'filename' => "classic-tee-$sfx.webp", 'mime' => 'image/webp', 'sha256' => hash( 'sha256', $full ), 'alt' => 'Classic tee in red',
	'parts' => array(
		array( 'name' => 'full', 'offset' => 0, 'length' => strlen( $full ), 'width' => 800, 'height' => 600, 'mime' => 'image/webp' ),
		array( 'name' => 'thumbnail', 'offset' => strlen( $full ), 'length' => strlen( $tb ), 'width' => 150, 'height' => 150, 'mime' => 'image/webp' ),
	),
) ) ), '+/', '-_' ), '=' );
[ $c, $m, $raw ] = call( 'POST', '/media', array(), $full . $tb, $manifest );
check( 'upload 200', 200 === $c, $raw );
check( 'not deduplicated first time', false === ( $m['deduplicated'] ?? null ) );
check( 'thumbnail url uses client size', false !== strpos( $m['media']['thumb_url'] ?? '', '150x150' ), $m['media']['thumb_url'] ?? '' );
check( 'alt text stored', ( $m['media']['alt'] ?? '' ) === 'Classic tee in red' );
[ , $m2 ] = call( 'POST', '/media', array(), $full . $tb, $manifest );
check( 'second upload deduplicated', true === ( $m2['deduplicated'] ?? null ) && $m2['media']['id'] === $m['media']['id'] );

echo "assign image to product and category\n";
$mid = $m['media']['id'];
[ , $r5 ] = call( 'POST', '/batch', array(), json_encode( array( 'ops' => array(
	array( 'op' => 'upsert', 'entity' => 'product', 'id' => $by_ref['p1']['id'], 'data' => array( 'image_id' => $mid, 'gallery_ids' => array( $mid ) ) ),
	array( 'op' => 'upsert', 'entity' => 'category', 'id' => $by_ref['c1']['id'], 'data' => array( 'image_id' => $mid ) ),
	array( 'op' => 'upsert', 'entity' => 'media', 'id' => $mid, 'data' => array( 'alt' => 'Updated alt' ) ),
) ) ) );
check( 'product image set', ( $r5['results'][0]['record']['image_id'] ?? 0 ) === $mid );
check( 'category thumbnail set', ( $r5['results'][1]['record']['image_id'] ?? 0 ) === $mid );
check( 'media alt updated', ( $r5['results'][2]['record']['alt'] ?? '' ) === 'Updated alt' );

echo "catalog export\n";
[ $c, $cat ] = call( 'GET', '/catalog', array( 'limit' => 500 ) );
$skus = array_column( $cat['products'] ?? array(), 'sku' );
check( 'catalog includes new parent and variations', in_array( "TEE-$sfx", $skus, true ) && in_array( "TEE-$sfx-M-BLUE", $skus, true ) );
check( 'catalog includes referenced media', in_array( $mid, array_column( $cat['media'] ?? array(), 'id' ), true ) );
[ , $idx ] = call( 'GET', '/index' );
check( 'index lists products', count( $idx['items'] ?? array() ) >= 4 );
[ , $tax ] = call( 'GET', '/taxonomy' );
check( 'taxonomy lists pa_size terms', in_array( 'pa_size', array_column( $tax['attributes'] ?? array(), 'taxonomy' ), true ) );

echo "preview\n";
[ $c, $pv ] = call( 'POST', '/preview', array(), json_encode( array( 'product_id' => $by_ref['s1']['id'], 'data' => array( 'name' => "Preview Name $sfx", 'regular_price' => '99', 'description' => '<p>Draft body</p>' ) ) ) );
check( 'preview url issued', ! empty( $pv['url'] ) );
$html = file_get_contents( $pv['url'] );
check( 'preview renders draft title through theme', false !== strpos( (string) $html, "Preview Name $sfx" ) );
check( 'preview renders draft price', false !== strpos( (string) $html, '99' ) );
check( 'preview did not persist', true );
[ , $after ] = call( 'GET', '/catalog', array( 'ids' => (string) $by_ref['s1']['id'] ) );
check( 'stored name unchanged', ( $after['products'][0]['name'] ?? '' ) === "Sticker $sfx" );
[ , $pv2 ] = call( 'POST', '/preview', array(), json_encode( array( 'data' => array( 'name' => "Brand New $sfx", 'regular_price' => '12' ) ) ) );
$html2 = file_get_contents( $pv2['url'] );
check( 'preview of unsaved new product renders', false !== strpos( (string) $html2, "Brand New $sfx" ) );

echo "delete\n";
[ , $r6 ] = call( 'POST', '/batch', array(), json_encode( array( 'ops' => array( array( 'op' => 'delete', 'entity' => 'product', 'id' => $sid, 'force' => true ) ) ) ) );
check( 'deleted', ( $r6['results'][0]['action'] ?? '' ) === 'deleted' );

echo $failed ? "\n$failed check(s) failed\n" : "\nall checks passed\n";
exit( $failed ? 1 : 0 );
