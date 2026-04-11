import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class JsonStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly parser?: (value: unknown) => T,
  ) {}

  async read(defaultValue: T): Promise<T> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as unknown;
      return this.parser ? this.parser(parsed) : (parsed as T);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultValue;
      }

      throw error;
    }
  }

  async write(value: T): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    const tmpPath = path.join(path.dirname(this.filePath), `${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    await writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
  }

  async quarantineCurrentFile(reason = "unreadable"): Promise<string | null> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    const quarantinePath = path.join(
      path.dirname(this.filePath),
      `${path.basename(this.filePath)}.${reason}.${randomUUID()}.bak`,
    );

    try {
      await rename(this.filePath, quarantinePath);
      return quarantinePath;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }
}
