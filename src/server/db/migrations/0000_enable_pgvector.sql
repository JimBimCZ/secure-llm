-- pgvector must exist before any table can declare a `vector` column.
-- The image is pgvector/pgvector, so the extension is available to install.
CREATE EXTENSION IF NOT EXISTS vector;
