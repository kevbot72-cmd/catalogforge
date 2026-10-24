<?php
/**
 * Bulk writer.
 *
 * Writes go through WooCommerce CRUD (so lookup tables, SEO plugins, translation plugins and
 * caches stay consistent) but expensive housekeeping is deferred to the end of the batch:
 * term counting is deferred, variable parents are synced once, transients are cleared once,
 * and the whole batch runs in a single database transaction.
 *
 * Batch format:
 * {
 *   "ops": [
 *     { "op": "upsert", "entity": "category", "ref": "c1", "data": { "name": "Shoes", "parent": 0 } },
 *     { "op": "upsert", "entity": "product",  "ref": "p1", "match": { "sku": "SH-1" },
 *       "data": { "name": "Runner", "category_ids": ["ref:c1"], "type": "variable" } },
 *     { "op": "upsert", "entity": "variation", "ref": "v1",
 *       "data": { "parent_id": "ref:p1", "variation_attributes": { "pa_size": "42" } } },
 *     { "op": "upsert", "entity": "product", "id": 15, "data": { "regular_price": "19.99" },
 *       "base": { "regular_price": "17.99" } },
 *     { "op": "delete", "entity": "product", "id": 99 }
 *   ],
 *   "options": { "conflicts": "check" | "overwrite", "transaction": true, "return_records": true }
 * }
 *
 * @package CatalogForge
 */

defined( 'ABSPATH' ) || exit;

class CF_Writer {

	/** @var array<string,int> client ref => real id */
	private $refs = array();
	/** @var int[] */
	private $touched_parents = array();
	/** @var int[] */
	private $touched = array();
	private $options;

	const ENTITY_ORDER = array(
		'category'  => 0,
		'tag'       => 1,
		'media'     => 2,
		'product'   => 3,
		'variation' => 4,
	);

	public function __construct( array $options = array() ) {
		$this->options = wp_parse_args(
			$options,
			array(
				'conflicts'      => 'check',
				'transaction'    => true,
				'return_records' => true,
			)
		);
	}

	/**
	 * @param array $ops Operations.
	 * @return array{results:array,elapsed_ms:int,refs:array}
	 */
	public function run( array $ops ) {
		global $wpdb;
		$start = microtime( true );

		// Upserts in dependency order (parents before children), deletes last (children first).
		$indexed = array();
		foreach ( array_values( $ops ) as $i => $op ) {
			$indexed[] = array( $i, $op );
		}
		usort(
			$indexed,
			static function ( $a, $b ) {
				$da = ( $a[1]['op'] ?? 'upsert' ) === 'delete';
				$db = ( $b[1]['op'] ?? 'upsert' ) === 'delete';
				if ( $da !== $db ) {
					return $da ? 1 : -1;
				}
				$ea = self::ENTITY_ORDER[ $a[1]['entity'] ?? 'product' ] ?? 9;
				$eb = self::ENTITY_ORDER[ $b[1]['entity'] ?? 'product' ] ?? 9;
				if ( $ea !== $eb ) {
					return $da ? $eb <=> $ea : $ea <=> $eb;
				}
				return $a[0] <=> $b[0];
			}
		);
		// Categories referencing other new categories must come after them.
		$indexed = $this->sort_categories( $indexed );

		// Deferred housekeeping: WooCommerce recounts category/tag totals and clears a dozen
		// transients on every single product save. During a batch those are postponed and done once.
		wp_defer_term_counting( true );
		add_filter( 'woocommerce_product_recount_terms', '__return_false' );
		// SKU uniqueness is checked by find_product_id() and WC_Product::set_sku() before insert;
		// WooCommerce's extra SKU lock can deadlock under concurrent batches.
		add_filter( 'wc_product_pre_lock_on_sku', '__return_true' );
		$memory_transients = ! wp_using_ext_object_cache();
		$this->memory_mode = $memory_transients;
		if ( $memory_transients ) {
			// Transient reads/writes go to the per-request cache instead of wp_options. Every
			// transient touched meanwhile is recorded and purged from the database afterwards.
			wp_using_ext_object_cache( true );
			add_action( 'all', array( $this, 'track_transient' ) );
		}

		$results = array();
		foreach ( $indexed as list( $i, $op ) ) {
			$results[ $i ] = $this->apply_atomic( $op );
		}

		if ( $memory_transients ) {
			remove_action( 'all', array( $this, 'track_transient' ) );
			wp_using_ext_object_cache( false );
		}
		remove_filter( 'wc_product_pre_lock_on_sku', '__return_true' );
		remove_filter( 'woocommerce_product_recount_terms', '__return_false' );
		wp_defer_term_counting( false );

		foreach ( array_unique( $this->touched_parents ) as $parent_id ) {
			WC_Product_Variable::sync( $parent_id );
		}
		$this->recount_terms();
		$this->purge_transients( $memory_transients );

		// Records are serialized after commit and parent sync so they reflect final state.
		if ( $this->options['return_records'] ) {
			foreach ( $results as &$r ) {
				if ( ! empty( $r['ok'] ) && ! empty( $r['id'] ) && 'deleted' !== $r['action'] ) {
					$r['record'] = $this->record( $r['entity'], $r['id'] );
				}
			}
			unset( $r );
		}

		ksort( $results );
		return array(
			'results'    => array_values( $results ),
			'refs'       => (object) $this->refs,
			'elapsed_ms' => (int) round( ( microtime( true ) - $start ) * 1000 ),
		);
	}

	/** @var bool transients are held in the in-request cache for this batch */
	private $memory_mode = false;

	/** @var string[] transients set or deleted while transients were held in memory */
	private $transients = array();

	public function track_transient( $hook ) {
		if ( 0 === strpos( $hook, 'delete_transient_' ) ) {
			$this->transients[] = substr( $hook, 17 );
		} elseif ( 0 === strpos( $hook, 'set_transient_' ) ) {
			$this->transients[] = substr( $hook, 14 );
		}
	}

	/**
	 * Runs one operation in its own transaction. A deadlock or lock timeout makes InnoDB roll
	 * back the transaction, so the operation is retried from scratch; an operation that fails
	 * part-way is rolled back so no half-written product is left behind.
	 */
	private function apply_atomic( array $op ) {
		global $wpdb, $EZSQL_ERROR;
		$use_tx = ! empty( $this->options['transaction'] );
		for ( $attempt = 1; ; $attempt++ ) {
			$errors_before = is_array( $EZSQL_ERROR ) ? count( $EZSQL_ERROR ) : 0;
			if ( $use_tx ) {
				$wpdb->query( 'START TRANSACTION' );
			}
			try {
				$result = $this->apply( $op );
			} catch ( Throwable $e ) {
				$result = array(
					'ref'    => $op['ref'] ?? null,
					'entity' => $op['entity'] ?? null,
					'ok'     => false,
					'action' => 'error',
					'error'  => $e->getMessage(),
				);
			}
			$lock_failure = false;
			foreach ( array_slice( is_array( $EZSQL_ERROR ) ? $EZSQL_ERROR : array(), $errors_before ) as $err ) {
				if ( preg_match( '/deadlock|lock wait timeout/i', (string) ( $err['error_str'] ?? '' ) ) ) {
					$lock_failure = true;
				}
			}
			$failed = empty( $result['ok'] ) && 'error' === ( $result['action'] ?? '' );
			if ( $use_tx && ( $lock_failure || $failed ) ) {
				$wpdb->query( 'ROLLBACK' );
				if ( ! empty( $op['ref'] ) ) {
					unset( $this->refs[ $op['ref'] ] );
				}
				// Drop anything cached from the rolled-back writes (only the in-request cache; a
				// persistent object cache is never flushed wholesale).
				if ( $this->memory_mode && function_exists( 'wp_cache_flush_runtime' ) ) {
					wp_cache_flush_runtime();
				}
			} elseif ( $use_tx ) {
				$wpdb->query( 'COMMIT' );
			}
			if ( $lock_failure && $attempt < 4 ) {
				usleep( 50000 * $attempt );
				continue;
			}
			if ( $lock_failure ) {
				$result = array( 'ref' => $op['ref'] ?? null, 'entity' => $op['entity'] ?? null, 'ok' => false, 'action' => 'error', 'error' => 'Database lock contention; please retry.' );
			}
			return $result;
		}
	}

	/**
	 * WooCommerce's visibility-aware category/tag counts, once for every term the batch touched.
	 */
	private function recount_terms() {
		if ( ! function_exists( '_wc_term_recount' ) ) {
			return;
		}
		foreach ( array( 'product_cat', 'product_tag' ) as $taxonomy ) {
			$terms = array();
			foreach ( array_unique( array_merge( $this->touched, $this->touched_parents ) ) as $id ) {
				$found = get_the_terms( $id, $taxonomy );
				if ( is_array( $found ) ) {
					foreach ( $found as $t ) {
						$terms[ $t->term_id ] = $t->parent;
					}
				}
			}
			if ( $terms ) {
				_wc_term_recount( $terms, get_taxonomy( $taxonomy ), false, false );
			}
		}
		delete_transient( 'wc_term_counts' );
	}

	/**
	 * Deletes product transients for everything touched with a few bulk queries instead of
	 * ~20 queries per product.
	 */
	private function purge_transients( $bulk ) {
		global $wpdb;
		$ids = array_unique( array_merge( $this->touched, $this->touched_parents ) );
		if ( ! $bulk ) {
			foreach ( $ids as $id ) {
				wc_delete_product_transients( $id );
			}
			return;
		}
		$names = array_merge(
			array( 'wc_products_onsale', 'wc_featured_products', 'wc_outofstock_count', 'wc_low_stock_count', 'wc_term_counts', 'wc_attribute_taxonomies' ),
			$this->transients
		);
		foreach ( $ids as $id ) {
			foreach ( array( 'wc_product_children_', 'wc_var_prices_', 'wc_child_has_weight_', 'wc_child_has_dimensions_', 'wc_related_' ) as $prefix ) {
				$names[] = $prefix . (int) $id;
			}
		}
		foreach ( array_chunk( $names, 400 ) as $chunk ) {
			$options = array();
			foreach ( $chunk as $n ) {
				$options[] = '_transient_' . $n;
				$options[] = '_transient_timeout_' . $n;
			}
			$placeholders = implode( ',', array_fill( 0, count( $options ), '%s' ) );
			$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name IN ($placeholders)", $options ) ); // phpcs:ignore WordPress.DB.PreparedSQL
		}
		wp_cache_delete( 'alloptions', 'options' );
	}

	private function sort_categories( array $indexed ) {
		$cats   = array();
		$others = array();
		foreach ( $indexed as $item ) {
			if ( 'category' === ( $item[1]['entity'] ?? '' ) && 'delete' !== ( $item[1]['op'] ?? 'upsert' ) ) {
				$cats[] = $item;
			} else {
				$others[] = $item;
			}
		}
		$sorted = array();
		$done   = array();
		$guard  = count( $cats ) + 1;
		while ( $cats && $guard-- > 0 ) {
			$rest = array();
			foreach ( $cats as $item ) {
				$parent = $item[1]['data']['parent'] ?? 0;
				if ( is_string( $parent ) && 0 === strpos( $parent, 'ref:' ) && ! isset( $done[ substr( $parent, 4 ) ] ) ) {
					$rest[] = $item;
					continue;
				}
				$sorted[] = $item;
				if ( isset( $item[1]['ref'] ) ) {
					$done[ $item[1]['ref'] ] = true;
				}
			}
			$cats = $rest;
		}
		return array_merge( $sorted, $cats, $others );
	}

	private function record( $entity, $id ) {
		if ( 'category' === $entity ) {
			$t = get_term( $id, 'product_cat' );
			return ( $t && ! is_wp_error( $t ) ) ? CF_Serializer::category( $t ) : null;
		}
		if ( 'media' === $entity ) {
			return CF_Serializer::media( $id );
		}
		if ( 'tag' === $entity ) {
			$t = get_term( $id, 'product_tag' );
			return ( $t && ! is_wp_error( $t ) ) ? array( 'id' => $t->term_id, 'name' => $t->name, 'slug' => $t->slug ) : null;
		}
		$p = wc_get_product( $id );
		return $p ? CF_Serializer::product( $p ) : null;
	}

	private function resolve( $value ) {
		if ( is_string( $value ) && 0 === strpos( $value, 'ref:' ) ) {
			$ref = substr( $value, 4 );
			if ( ! isset( $this->refs[ $ref ] ) ) {
				throw new RuntimeException( "Unresolved reference '{$ref}'." );
			}
			return $this->refs[ $ref ];
		}
		return (int) $value;
	}

	private function apply( array $op ) {
		$entity = $op['entity'] ?? 'product';
		$action = $op['op'] ?? 'upsert';
		$res    = array( 'ref' => $op['ref'] ?? null, 'entity' => $entity );

		switch ( $entity ) {
			case 'category':
				$out = 'delete' === $action ? $this->delete_term( $op, 'product_cat' ) : $this->upsert_category( $op );
				break;
			case 'tag':
				$out = 'delete' === $action ? $this->delete_term( $op, 'product_tag' ) : $this->upsert_tag( $op );
				break;
			case 'media':
				$out = 'delete' === $action ? $this->delete_media( $op ) : $this->update_media( $op );
				break;
			case 'product':
			case 'variation':
				$out = 'delete' === $action ? $this->delete_product( $op ) : $this->upsert_product( $op, 'variation' === $entity );
				break;
			default:
				throw new InvalidArgumentException( "Unknown entity '{$entity}'." );
		}
		$res = array_merge( $res, $out );
		if ( ! empty( $op['ref'] ) && ! empty( $res['id'] ) ) {
			$this->refs[ $op['ref'] ] = (int) $res['id'];
		}
		return $res;
	}

	/* ------------------------------------------------------------------ products */

	private function find_product_id( array $op ) {
		if ( ! empty( $op['id'] ) ) {
			return (int) $op['id'];
		}
		$sku = $op['match']['sku'] ?? '';
		if ( '' !== $sku ) {
			$id = wc_get_product_id_by_sku( $sku );
			if ( $id ) {
				return (int) $id;
			}
		}
		$slug = $op['match']['slug'] ?? '';
		if ( '' !== $slug ) {
			$post = get_page_by_path( $slug, OBJECT, 'product' );
			if ( $post ) {
				return (int) $post->ID;
			}
		}
		return 0;
	}

	private function upsert_product( array $op, $is_variation ) {
		$data = $op['data'] ?? array();
		$id   = $this->find_product_id( $op );

		if ( $id ) {
			$existing = wc_get_product( $id );
			if ( ! $existing ) {
				if ( ! empty( $op['id'] ) ) {
					return array( 'ok' => false, 'action' => 'missing', 'id' => $id, 'error' => 'Product no longer exists on the store.' );
				}
				$id = 0;
			}
		}

		if ( $id && 'check' === $this->options['conflicts'] && ! empty( $op['base'] ) ) {
			// Custom fields arrive as data.meta and are compared as "meta:<key>" fields.
			$meta_keys = array();
			foreach ( array_keys( $op['base'] ) as $f ) {
				if ( 0 === strpos( $f, 'meta:' ) ) {
					$meta_keys[] = substr( $f, 5 );
				}
			}
			$conflicts = $this->conflicts( self::flat_meta( CF_Serializer::product( $existing, $meta_keys ) ), $op['base'], self::flat_meta( $data ) );
			if ( $conflicts ) {
				return array( 'ok' => false, 'action' => 'conflict', 'id' => $id, 'conflicts' => $conflicts );
			}
		}

		if ( $is_variation ) {
			$product = $id ? $existing : new WC_Product_Variation();
		} else {
			$type = $data['type'] ?? ( $id ? $existing->get_type() : 'simple' );
			if ( $id && $existing->get_type() === $type ) {
				$product = $existing;
			} else {
				$class = WC_Product_Factory::get_classname_from_product_type( $type );
				if ( ! $class || ! class_exists( $class ) ) {
					throw new InvalidArgumentException( "Unknown product type '{$type}'." );
				}
				$product = new $class( $id );
			}
		}

		$this->apply_product_data( $product, $data, $is_variation );
		$product->save();

		$new_id          = $product->get_id();
		$this->touched[] = $new_id;
		if ( $is_variation && $product->get_parent_id() ) {
			$this->touched_parents[] = $product->get_parent_id();
		} elseif ( $product->is_type( 'variable' ) ) {
			$this->touched_parents[] = $new_id;
		}

		return array( 'ok' => true, 'action' => $id ? 'updated' : 'created', 'id' => $new_id );
	}

	/**
	 * Fields where a base→remote mismatch counts as a conflict only when the incoming value
	 * also differs from the remote (i.e. both sides changed the same field differently).
	 */
	private function conflicts( array $remote, array $base, array $incoming ) {
		$out = array();
		foreach ( $base as $field => $base_value ) {
			if ( ! array_key_exists( $field, $remote ) ) {
				continue;
			}
			$r = self::norm( $remote[ $field ] );
			if ( $r === self::norm( $base_value ) ) {
				continue;
			}
			if ( array_key_exists( $field, $incoming ) && $r === self::norm( $incoming[ $field ] ) ) {
				continue; // Both sides arrived at the same value.
			}
			$out[] = array(
				'field'    => $field,
				'base'     => $base_value,
				'remote'   => $remote[ $field ],
				'incoming' => $incoming[ $field ] ?? null,
			);
		}
		return $out;
	}

	private static function flat_meta( array $row ) {
		if ( isset( $row['meta'] ) && ( is_array( $row['meta'] ) || is_object( $row['meta'] ) ) ) {
			foreach ( (array) $row['meta'] as $k => $v ) {
				$row[ 'meta:' . $k ] = $v;
			}
			unset( $row['meta'] );
		}
		return $row;
	}

	private static function norm( $v ) {
		if ( is_bool( $v ) ) {
			return $v ? '1' : '0';
		}
		if ( null === $v ) {
			return '';
		}
		if ( is_array( $v ) || is_object( $v ) ) {
			return wp_json_encode( $v );
		}
		return (string) $v;
	}

	private function apply_product_data( WC_Product $product, array $data, $is_variation ) {
		$simple_setters = array(
			'name'               => 'set_name',
			'slug'               => 'set_slug',
			'status'             => 'set_status',
			'sku'                => 'set_sku',
			'global_unique_id'   => 'set_global_unique_id',
			'regular_price'      => 'set_regular_price',
			'sale_price'         => 'set_sale_price',
			'date_on_sale_from'  => 'set_date_on_sale_from',
			'date_on_sale_to'    => 'set_date_on_sale_to',
			'manage_stock'       => 'set_manage_stock',
			'stock_quantity'     => 'set_stock_quantity',
			'stock_status'       => 'set_stock_status',
			'backorders'         => 'set_backorders',
			'weight'             => 'set_weight',
			'length'             => 'set_length',
			'width'              => 'set_width',
			'height'             => 'set_height',
			'tax_status'         => 'set_tax_status',
			'tax_class'          => 'set_tax_class',
			'description'        => 'set_description',
			'short_description'  => 'set_short_description',
			'menu_order'         => 'set_menu_order',
			'featured'           => 'set_featured',
			'catalog_visibility' => 'set_catalog_visibility',
			'virtual'            => 'set_virtual',
			'downloadable'       => 'set_downloadable',
			'external_url'       => 'set_product_url',
			'button_text'        => 'set_button_text',
		);
		if ( $is_variation && isset( $data['parent_id'] ) ) {
			$product->set_parent_id( $this->resolve( $data['parent_id'] ) );
		}
		foreach ( $simple_setters as $field => $setter ) {
			if ( array_key_exists( $field, $data ) && is_callable( array( $product, $setter ) ) ) {
				$value = $data[ $field ];
				if ( 'sku' === $field && null === $value ) {
					$value = '';
				}
				$product->{$setter}( $value );
			}
		}
		if ( array_key_exists( 'image_id', $data ) ) {
			$product->set_image_id( $data['image_id'] ? $this->resolve( $data['image_id'] ) : '' );
		}
		if ( ! $is_variation ) {
			if ( array_key_exists( 'gallery_ids', $data ) ) {
				$product->set_gallery_image_ids( array_map( array( $this, 'resolve' ), (array) $data['gallery_ids'] ) );
			}
			if ( array_key_exists( 'category_ids', $data ) ) {
				$product->set_category_ids( array_map( array( $this, 'resolve' ), (array) $data['category_ids'] ) );
			}
			if ( array_key_exists( 'tags', $data ) ) {
				$product->set_tag_ids( $this->tag_ids( (array) $data['tags'] ) );
			}
			if ( array_key_exists( 'attributes', $data ) ) {
				$product->set_attributes( $this->build_attributes( (array) $data['attributes'] ) );
			}
		} elseif ( array_key_exists( 'variation_attributes', $data ) ) {
			$product->set_attributes( $this->variation_attributes( (array) $data['variation_attributes'] ) );
		}
		if ( array_key_exists( 'shipping_class', $data ) ) {
			$slug = (string) $data['shipping_class'];
			$id   = 0;
			if ( '' !== $slug ) {
				$term = get_term_by( 'slug', $slug, 'product_shipping_class' );
				if ( ! $term ) {
					$created = wp_insert_term( $slug, 'product_shipping_class', array( 'slug' => sanitize_title( $slug ) ) );
					$id      = is_wp_error( $created ) ? 0 : (int) $created['term_id'];
				} else {
					$id = (int) $term->term_id;
				}
			}
			$product->set_shipping_class_id( $id );
		}
		foreach ( CF_Serializer::seo_meta_map() as $field => $keys ) {
			if ( array_key_exists( $field, $data ) ) {
				foreach ( $keys as $key ) {
					$product->update_meta_data( $key, (string) $data[ $field ] );
				}
			}
		}
		if ( ! empty( $data['meta'] ) && is_array( $data['meta'] ) ) {
			foreach ( $data['meta'] as $key => $value ) {
				if ( null === $value ) {
					$product->delete_meta_data( $key );
				} else {
					$product->update_meta_data( $key, $value );
				}
			}
		}
		if ( ! empty( $data['source_ref'] ) ) {
			// Stable cross-environment identity (Local → staging → live promotion).
			$product->update_meta_data( '_cf_guid', sanitize_text_field( $data['source_ref'] ) );
		}
	}

	private function tag_ids( array $names ) {
		$ids = array();
		foreach ( $names as $name ) {
			$name = trim( (string) $name );
			if ( '' === $name ) {
				continue;
			}
			$term = get_term_by( 'name', $name, 'product_tag' );
			if ( ! $term ) {
				$created = wp_insert_term( $name, 'product_tag' );
				if ( is_wp_error( $created ) ) {
					if ( 'term_exists' === $created->get_error_code() ) {
						$ids[] = (int) $created->get_error_data();
					}
					continue;
				}
				$ids[] = (int) $created['term_id'];
			} else {
				$ids[] = (int) $term->term_id;
			}
		}
		return $ids;
	}

	/**
	 * Ensures a global attribute taxonomy exists and is registered for this request.
	 */
	private function ensure_attribute_taxonomy( $taxonomy, $label ) {
		$slug = wc_sanitize_taxonomy_name( preg_replace( '/^pa_/', '', $taxonomy ) );
		$tax  = wc_attribute_taxonomy_name( $slug );
		if ( ! wc_attribute_taxonomy_id_by_name( $tax ) ) {
			$created = wc_create_attribute(
				array(
					'name' => $label ? $label : $slug,
					'slug' => $slug,
				)
			);
			if ( is_wp_error( $created ) ) {
				throw new RuntimeException( $created->get_error_message() );
			}
		}
		if ( ! taxonomy_exists( $tax ) ) {
			register_taxonomy( $tax, array( 'product', 'product_variation' ), array( 'hierarchical' => false, 'show_ui' => false, 'query_var' => true, 'rewrite' => false ) );
		}
		return $tax;
	}

	/**
	 * @param string   $taxonomy Attribute taxonomy.
	 * @param string   $name     Term name or slug.
	 * @param int|null $position For newly created terms: their sort position, so "S, M, L" keeps
	 *                           that order instead of WooCommerce's alphabetical fallback.
	 */
	private function ensure_attribute_term( $taxonomy, $name, $position = null ) {
		$name = (string) $name;
		$term = get_term_by( 'name', $name, $taxonomy );
		if ( ! $term ) {
			$term = get_term_by( 'slug', sanitize_title( $name ), $taxonomy );
		}
		if ( $term ) {
			return $term;
		}
		$created = wp_insert_term( $name, $taxonomy );
		if ( is_wp_error( $created ) ) {
			if ( 'term_exists' === $created->get_error_code() ) {
				return get_term( (int) $created->get_error_data(), $taxonomy );
			}
			throw new RuntimeException( $created->get_error_message() );
		}
		if ( null !== $position ) {
			update_term_meta( (int) $created['term_id'], 'order', (int) $position );
		}
		return get_term( (int) $created['term_id'], $taxonomy );
	}

	private function build_attributes( array $attrs ) {
		$out = array();
		foreach ( array_values( $attrs ) as $pos => $a ) {
			$attr     = new WC_Product_Attribute();
			$taxonomy = (string) ( $a['taxonomy'] ?? '' );
			$options  = array_values( array_filter( array_map( 'strval', (array) ( $a['options'] ?? array() ) ), 'strlen' ) );
			if ( '' !== $taxonomy ) {
				$tax = $this->ensure_attribute_taxonomy( $taxonomy, $a['name'] ?? '' );
				$ids = array();
				foreach ( $options as $i => $o ) {
					$ids[] = (int) $this->ensure_attribute_term( $tax, $o, $i )->term_id;
				}
				$attr->set_id( wc_attribute_taxonomy_id_by_name( $tax ) );
				$attr->set_name( $tax );
				$attr->set_options( $ids );
			} else {
				$attr->set_id( 0 );
				$attr->set_name( (string) ( $a['name'] ?? '' ) );
				$attr->set_options( $options );
			}
			$attr->set_position( isset( $a['position'] ) ? (int) $a['position'] : $pos );
			$attr->set_visible( ! empty( $a['visible'] ) || ! isset( $a['visible'] ) );
			$attr->set_variation( ! empty( $a['variation'] ) );
			$out[] = $attr;
		}
		return $out;
	}

	private function variation_attributes( array $attrs ) {
		$out = array();
		foreach ( $attrs as $key => $value ) {
			$key = (string) $key;
			if ( 0 === strpos( $key, 'pa_' ) ) {
				$tax = $this->ensure_attribute_taxonomy( $key, '' );
				$out[ $tax ] = '' === (string) $value ? '' : $this->ensure_attribute_term( $tax, $value )->slug;
			} else {
				$out[ sanitize_title( $key ) ] = (string) $value;
			}
		}
		return $out;
	}

	private function delete_product( array $op ) {
		$id      = $this->find_product_id( $op );
		$product = $id ? wc_get_product( $id ) : null;
		if ( ! $product ) {
			return array( 'ok' => true, 'action' => 'deleted', 'id' => $id, 'note' => 'already absent' );
		}
		$force = ! empty( $op['force'] );
		if ( $product->is_type( 'variable' ) && $force ) {
			foreach ( $product->get_children() as $child_id ) {
				$child = wc_get_product( $child_id );
				if ( $child ) {
					$child->delete( true );
				}
			}
		}
		$parent = $product->get_parent_id();
		$product->delete( $force );
		if ( $parent ) {
			$this->touched_parents[] = $parent;
		}
		return array( 'ok' => true, 'action' => 'deleted', 'id' => $id );
	}

	/* ---------------------------------------------------------------- taxonomy */

	private function upsert_category( array $op ) {
		$data = $op['data'] ?? array();
		$id   = ! empty( $op['id'] ) ? (int) $op['id'] : 0;
		if ( ! $id && ! empty( $op['match']['slug'] ) ) {
			$t  = get_term_by( 'slug', $op['match']['slug'], 'product_cat' );
			$id = $t ? (int) $t->term_id : 0;
		}
		if ( ! $id && ! empty( $op['match']['path'] ) ) {
			$id = $this->category_by_path( (string) $op['match']['path'] );
		}

		if ( $id && 'check' === $this->options['conflicts'] && ! empty( $op['base'] ) ) {
			$t = get_term( $id, 'product_cat' );
			if ( $t && ! is_wp_error( $t ) ) {
				$conflicts = $this->conflicts( CF_Serializer::category( $t ), $op['base'], $data );
				if ( $conflicts ) {
					return array( 'ok' => false, 'action' => 'conflict', 'id' => $id, 'conflicts' => $conflicts );
				}
			}
		}

		$args = array();
		foreach ( array( 'name', 'slug', 'description' ) as $f ) {
			if ( array_key_exists( $f, $data ) ) {
				$args[ $f ] = $data[ $f ];
			}
		}
		if ( array_key_exists( 'parent', $data ) ) {
			$args['parent'] = $data['parent'] ? $this->resolve( $data['parent'] ) : 0;
		}

		if ( $id ) {
			$r = $args ? wp_update_term( $id, 'product_cat', $args ) : array( 'term_id' => $id );
		} else {
			$name = $args['name'] ?? '';
			unset( $args['name'] );
			$r = wp_insert_term( $name, 'product_cat', $args );
			if ( is_wp_error( $r ) && 'term_exists' === $r->get_error_code() ) {
				$r = array( 'term_id' => (int) $r->get_error_data() );
			}
		}
		if ( is_wp_error( $r ) ) {
			return array( 'ok' => false, 'action' => 'error', 'id' => $id, 'error' => $r->get_error_message() );
		}
		$term_id = (int) $r['term_id'];

		$meta = array(
			'display_type' => 'display_type',
			'image_id'     => 'thumbnail_id',
			'banner_id'    => '_cf_banner_id',
			'menu_order'   => 'order',
		);
		foreach ( $meta as $field => $key ) {
			if ( array_key_exists( $field, $data ) ) {
				$value = $data[ $field ];
				if ( in_array( $field, array( 'image_id', 'banner_id' ), true ) && $value ) {
					$value = $this->resolve( $value );
				}
				update_term_meta( $term_id, $key, $value );
			}
		}
		$seo_keys = defined( 'RANK_MATH_VERSION' )
			? array( 'seo_title' => 'rank_math_title', 'seo_description' => 'rank_math_description' )
			: array( 'seo_title' => '_cf_seo_title', 'seo_description' => '_cf_seo_description' );
		foreach ( $seo_keys as $field => $key ) {
			if ( array_key_exists( $field, $data ) ) {
				update_term_meta( $term_id, $key, (string) $data[ $field ] );
			}
		}
		if ( ! empty( $data['meta'] ) && is_array( $data['meta'] ) ) {
			foreach ( $data['meta'] as $key => $value ) {
				update_term_meta( $term_id, $key, $value );
			}
		}
		return array( 'ok' => true, 'action' => $id ? 'updated' : 'created', 'id' => $term_id );
	}

	/**
	 * Resolves "Clothing > Men > Shirts", creating nothing.
	 */
	private function category_by_path( $path ) {
		$parent = 0;
		foreach ( array_map( 'trim', explode( '>', $path ) ) as $name ) {
			$found = 0;
			foreach ( get_terms( array( 'taxonomy' => 'product_cat', 'hide_empty' => false, 'parent' => $parent, 'name' => $name ) ) as $t ) {
				$found = (int) $t->term_id;
				break;
			}
			if ( ! $found ) {
				return 0;
			}
			$parent = $found;
		}
		return $parent;
	}

	private function upsert_tag( array $op ) {
		$data = $op['data'] ?? array();
		$id   = ! empty( $op['id'] ) ? (int) $op['id'] : 0;
		if ( $id ) {
			$r = wp_update_term( $id, 'product_tag', array_intersect_key( $data, array_flip( array( 'name', 'slug', 'description' ) ) ) );
		} else {
			$r = wp_insert_term( (string) ( $data['name'] ?? '' ), 'product_tag', array_intersect_key( $data, array_flip( array( 'slug', 'description' ) ) ) );
			if ( is_wp_error( $r ) && 'term_exists' === $r->get_error_code() ) {
				$r = array( 'term_id' => (int) $r->get_error_data() );
			}
		}
		if ( is_wp_error( $r ) ) {
			return array( 'ok' => false, 'action' => 'error', 'id' => $id, 'error' => $r->get_error_message() );
		}
		return array( 'ok' => true, 'action' => $id ? 'updated' : 'created', 'id' => (int) $r['term_id'] );
	}

	private function delete_term( array $op, $taxonomy ) {
		$id = (int) ( $op['id'] ?? 0 );
		if ( ! $id ) {
			return array( 'ok' => false, 'action' => 'error', 'error' => 'Term id required for delete.' );
		}
		$r = wp_delete_term( $id, $taxonomy );
		if ( is_wp_error( $r ) ) {
			return array( 'ok' => false, 'action' => 'error', 'id' => $id, 'error' => $r->get_error_message() );
		}
		return array( 'ok' => true, 'action' => 'deleted', 'id' => $id );
	}

	/* ------------------------------------------------------------------- media */

	private function update_media( array $op ) {
		$id   = (int) ( $op['id'] ?? 0 );
		$data = $op['data'] ?? array();
		if ( ! $id || 'attachment' !== get_post_type( $id ) ) {
			return array( 'ok' => false, 'action' => 'error', 'id' => $id, 'error' => 'Attachment not found.' );
		}
		if ( array_key_exists( 'alt', $data ) ) {
			update_post_meta( $id, '_wp_attachment_image_alt', sanitize_text_field( $data['alt'] ) );
		}
		$post = array( 'ID' => $id );
		if ( array_key_exists( 'title', $data ) ) {
			$post['post_title'] = sanitize_text_field( $data['title'] );
		}
		if ( array_key_exists( 'caption', $data ) ) {
			$post['post_excerpt'] = wp_kses_post( $data['caption'] );
		}
		if ( count( $post ) > 1 ) {
			wp_update_post( $post );
		}
		return array( 'ok' => true, 'action' => 'updated', 'id' => $id );
	}

	private function delete_media( array $op ) {
		$id = (int) ( $op['id'] ?? 0 );
		if ( $id && 'attachment' === get_post_type( $id ) ) {
			wp_delete_attachment( $id, true );
		}
		return array( 'ok' => true, 'action' => 'deleted', 'id' => $id );
	}
}
