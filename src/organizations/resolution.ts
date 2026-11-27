import type { DatabaseRuntime, QueryRow } from "../db/runtime/index.js";

/**
 * Resolves an operator reference to the organization it names.
 *
 * A slug is what links and the panel use, but a provisioned organization carries an id suffix, so
 * an operator who only knows the configured name would have to open the panel to learn it. The
 * reference therefore accepts the slug, the id, or a name that matches exactly one organization.
 *
 * @param database - Database runtime
 * @param reference - Slug, id, or unique name
 * @returns Organization id, or undefined when nothing matches
 */
export async function resolveOrganizationId(
  database: DatabaseRuntime,
  reference: string,
): Promise<string | undefined> {
  for (const column of ["slug", "id"] as const) {
    const result = await database.query<QueryRow & { id: string }>(
      `select id from organization where ${column} = $1`,
      [reference],
    );
    if (result.rows[0] !== undefined) return result.rows[0].id;
  }
  const byName = await database.query<QueryRow & { id: string }>(
    "select id from organization where lower(name) = lower($1) limit 2",
    [reference],
  );
  if (byName.rows.length > 1) {
    throw new Error(`organization ${reference} is ambiguous; declare its slug or id`);
  }
  return byName.rows[0]?.id;
}
