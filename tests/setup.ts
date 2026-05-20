// Provide a DATABASE_URL for module-load-time env validation so tests can run
// without a real Postgres. Integration tests override this with the real URL.
process.env.DATABASE_URL ??=
  'postgres://postgres:postgres@localhost:5432/licitaciones';
