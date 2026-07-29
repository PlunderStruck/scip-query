export const TARGET_COUPLING_SQL = `SELECT COUNT(*) AS shared
  FROM (
    SELECT definition_m.symbol_id
    FROM documents definition_d
    JOIN chunks definition_c ON definition_c.document_id = definition_d.id
    JOIN mentions definition_m ON definition_m.chunk_id = definition_c.id
      AND definition_m.role = 1
    JOIN mentions reference_m ON reference_m.symbol_id = definition_m.symbol_id
      AND reference_m.role != 1
    JOIN chunks reference_c ON reference_c.id = reference_m.chunk_id
    JOIN documents reference_d ON reference_d.id = reference_c.document_id
    WHERE definition_d.relative_path = ?
      AND reference_d.relative_path = ?
    UNION
    SELECT definition_m.symbol_id
    FROM documents definition_d
    JOIN chunks definition_c ON definition_c.document_id = definition_d.id
    JOIN mentions definition_m ON definition_m.chunk_id = definition_c.id
      AND definition_m.role = 1
    JOIN mentions reference_m ON reference_m.symbol_id = definition_m.symbol_id
      AND reference_m.role != 1
    JOIN chunks reference_c ON reference_c.id = reference_m.chunk_id
    JOIN documents reference_d ON reference_d.id = reference_c.document_id
    WHERE definition_d.relative_path = ?
      AND reference_d.relative_path = ?
  )`;
