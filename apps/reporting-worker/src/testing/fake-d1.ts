import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from "../d1-store.js";

export interface RecordedStatement {
  readonly sql: string;
  readonly values: readonly unknown[];
}

export class FakeD1Database implements D1DatabaseLike {
  readonly statements: RecordedStatement[] = [];
  readonly #database: DatabaseSync;
  #failBatchStatement: number | undefined;

  constructor(migrationSql: string) {
    this.#database = new DatabaseSync(":memory:");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec(migrationSql);
  }

  prepare(sql: string): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this, sql, []);
  }

  async batch<T = Record<string, unknown>>(
    statements: readonly D1PreparedStatementLike[],
  ): Promise<readonly D1ResultLike<T>[]> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1ResultLike<T>[] = [];
      for (const [index, statement] of statements.entries()) {
        if (!(statement instanceof FakeD1PreparedStatement)) {
          throw new TypeError("Fake D1 received an unknown prepared statement");
        }
        if (this.#failBatchStatement === index) {
          this.#failBatchStatement = undefined;
          throw new Error(`simulated D1 batch failure at statement ${index}`);
        }
        results.push(this.execute<T>(statement.sql, statement.values));
      }
      this.#database.exec("COMMIT");
      return results;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  failNextBatchAt(statementIndex: number): void {
    if (!Number.isSafeInteger(statementIndex) || statementIndex < 0) {
      throw new TypeError("batch failure index must be a non-negative integer");
    }
    this.#failBatchStatement = statementIndex;
  }

  query<T extends Record<string, unknown>>(sql: string): readonly T[] {
    return this.#database.prepare(sql).all() as T[];
  }

  execute<T>(sql: string, values: readonly unknown[]): D1ResultLike<T> {
    this.statements.push({ sql, values: [...values] });
    const statement = this.#database.prepare(sql);
    const boundValues = values.map(toSqlValue);
    const results = statement.all(...boundValues) as T[];
    return { success: true, results };
  }

  close(): void {
    this.#database.close();
  }
}

export class FakeD1PreparedStatement implements D1PreparedStatementLike {
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly #database: FakeD1Database;

  constructor(database: FakeD1Database, sql: string, values: readonly unknown[]) {
    this.#database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: readonly unknown[]): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this.#database, this.sql, values);
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return this.#database.execute<T>(this.sql, this.values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (await this.all<T>()).results[0] ?? null;
  }

  async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return this.all<T>();
  }
}

function toSqlValue(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new TypeError(`Fake D1 cannot bind a ${typeof value} value`);
}
