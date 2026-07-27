export class PgPlaidSecretRepository {
  #pool;

  constructor(pool) {
    this.#pool = pool;
  }

  async put(itemId, accessToken, client = this.#pool) {
    if (!itemId || !accessToken) {
      throw new TypeError("itemId and accessToken are required");
    }
    await client.query(
      `
        INSERT INTO plaid_item_secrets (connection_id, access_token)
        VALUES ($1, $2)
        ON CONFLICT (connection_id) DO UPDATE
        SET access_token = EXCLUDED.access_token, updated_at = now()
      `,
      [itemId, accessToken],
    );
  }

  async get(itemId, client = this.#pool) {
    const result = await client.query(
      "SELECT access_token FROM plaid_item_secrets WHERE connection_id = $1",
      [itemId],
    );
    return result.rows[0]?.access_token ?? null;
  }

  async delete(itemId, client = this.#pool) {
    await client.query(
      "DELETE FROM plaid_item_secrets WHERE connection_id = $1",
      [itemId],
    );
  }
}
