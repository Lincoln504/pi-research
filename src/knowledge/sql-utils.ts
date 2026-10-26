/**
 * SQL string literal for the knowledge store's DataFusion queries.
 *
 * The store builds LanceDB/DataFusion SQL by string interpolation, and the
 * interpolated values are attacker-influenced (stored URLs, workspace paths,
 * ingestion types). Every interpolated string MUST go through here so the
 * escaping rule is written once and cannot drift across the call sites.
 *
 * DataFusion's string-literal grammar escapes a single quote by doubling it
 * (standard SQL `''`); that is the only escape the engine applies on read-back,
 * which is why doubling is the complete rule for this dialect.
 */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
