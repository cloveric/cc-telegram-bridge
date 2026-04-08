import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class JsonStore<T> {
  constructor(private readonly filePath: string) {}

  async read(defaultValue: T): Promise<T> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      return JSON.parse(contents) as T;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultValue;
      }

      throw error;
    }
  }

  async write(value: T): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
  }
}
