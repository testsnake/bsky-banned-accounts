import Database from "better-sqlite3";
import path from "path";
import { logger } from "./logger";

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "user.db");

export interface UserEntry {
    id?: number;
    did: string;
    takedownSrc: string;
    takedownDate: number;
}

export class UserDatabase {
    private readonly db = new Database(DB_PATH, { verbose: (msg) => logger.debug({ msg }, "DB") });
    private static instance: UserDatabase | null = null;

    private constructor() {
        this.initialize();
    }

    private initialize(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS user_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                did TEXT NOT NULL,
                takedownSrc TEXT NOT NULL,
                takedownDate INTEGER NOT NULL,
                UNIQUE(did, takedownSrc)
            );
        `);
    }

    public static getInstance(): UserDatabase {
        if (!UserDatabase.instance) {
            UserDatabase.instance = new UserDatabase();
        }
        return UserDatabase.instance;
    }

    private rowToEntry(row: any): UserEntry {
        return { ...row };
    }

    public upsert(entry: UserEntry): void {
        const stmt = this.db.prepare(`
            INSERT INTO user_entries (did, takedownSrc, takedownDate)
            VALUES (@did, @takedownSrc, @takedownDate)
            ON CONFLICT(did, takedownSrc) DO UPDATE SET
                takedownDate = excluded.takedownDate
        `);

        stmt.run(entry);
    }

    public remove(did: string, takedownSrc: string): void {
        const stmt = this.db.prepare(`DELETE FROM user_entries WHERE did = ? AND takedownSrc = ?`);
        stmt.run(did, takedownSrc);
    }

    public getByDidAndSrc(did: string, takedownSrc: string): UserEntry | null {
        const stmt = this.db.prepare(`SELECT * FROM user_entries WHERE did = ? AND takedownSrc = ?`);
        const row = stmt.get(did, takedownSrc);
        return row ? this.rowToEntry(row) : null;
    }

    public getAll(): UserEntry[] {
        const stmt = this.db.prepare(`SELECT * FROM user_entries`);
        return stmt.all().map(this.rowToEntry);
    }

    public close(): void {
        this.db.close();
        UserDatabase.instance = null;
    }
}
