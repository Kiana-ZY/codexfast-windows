import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

type AsarIntegrity = {
  algorithm?: string;
  hash?: string;
};

type AsarHeaderEntry = {
  files?: Record<string, AsarHeaderEntry>;
  integrity?: AsarIntegrity;
  link?: string;
  offset?: string;
  size?: number;
  unpacked?: boolean;
};

export type ReadOnlyAsarFile = {
  path: string;
  size: number;
  offset: number;
  unpacked: boolean;
  integrity: AsarIntegrity | null;
};

export type ReadOnlyFileSnapshot = {
  sha256: string;
  size: number;
  mtimeMs: number;
};

export type ReadOnlyFileContentSnapshot = ReadOnlyFileSnapshot & {
  content: Buffer;
};

const asarPicklePrefixSize = 8;
const asarMaximumHeaderSize = 64 * 1024 * 1024;
const asarHashBufferSize = 1024 * 1024;

function readExactly(
  fd: number,
  length: number,
  position: number,
  label: string,
): Buffer {
  const buffer = Buffer.alloc(length);
  let readOffset = 0;
  while (readOffset < length) {
    const bytesRead = readSync(
      fd,
      buffer,
      readOffset,
      length - readOffset,
      position + readOffset,
    );
    if (bytesRead <= 0) {
      throw new Error(`Unexpected end of app.asar while reading ${label}.`);
    }
    readOffset += bytesRead;
  }
  return buffer;
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function validateAsarEntryName(name: string, parentPath: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(
      `Invalid app.asar entry name ${JSON.stringify(name)} under ${parentPath || "<root>"}.`,
    );
  }
}

function parseAsarOffset(value: string | undefined, entryPath: string): number {
  if (!value || !/^\d+$/u.test(value)) {
    throw new Error(`Invalid app.asar offset for ${entryPath}.`);
  }
  const offset = BigInt(value);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`app.asar offset is too large for ${entryPath}.`);
  }
  return Number(offset);
}

function flattenAsarFiles(
  entry: AsarHeaderEntry,
  archiveSize: number,
  dataOffset: number,
): ReadOnlyAsarFile[] {
  if (!entry.files || typeof entry.files !== "object") {
    throw new Error("app.asar header does not contain a root files object.");
  }
  const files: ReadOnlyAsarFile[] = [];
  const normalizedPaths = new Set<string>();

  const visit = (
    entries: Record<string, AsarHeaderEntry>,
    parentPath: string,
  ): void => {
    for (const [name, child] of Object.entries(entries)) {
      validateAsarEntryName(name, parentPath);
      const entryPath = parentPath ? `${parentPath}/${name}` : name;
      if (normalizedPaths.has(entryPath)) {
        throw new Error(`Duplicate app.asar entry path ${entryPath}.`);
      }
      normalizedPaths.add(entryPath);

      if (child.files) {
        visit(child.files, entryPath);
        continue;
      }
      if (child.link) {
        continue;
      }
      if (!Number.isSafeInteger(child.size) || (child.size ?? -1) < 0) {
        throw new Error(`Invalid app.asar size for ${entryPath}.`);
      }
      const size = child.size ?? 0;
      const unpacked = child.unpacked === true;
      const offset = unpacked ? 0 : parseAsarOffset(child.offset, entryPath);
      if (!unpacked && dataOffset + offset + size > archiveSize) {
        throw new Error(`app.asar entry ${entryPath} extends past the archive.`);
      }
      files.push({
        path: entryPath,
        size,
        offset,
        unpacked,
        integrity: child.integrity ?? null,
      });
    }
  };

  visit(entry.files, "");
  return files;
}

export class ReadOnlyAsarArchive {
  readonly archivePath: string;
  readonly files: ReadOnlyAsarFile[];
  readonly initialStat: Stats;
  private readonly dataOffset: number;
  private readonly fd: number;
  private closed = false;

  private constructor(
    archivePath: string,
    fd: number,
    initialStat: Stats,
    dataOffset: number,
    files: ReadOnlyAsarFile[],
  ) {
    this.archivePath = archivePath;
    this.fd = fd;
    this.initialStat = initialStat;
    this.dataOffset = dataOffset;
    this.files = files;
  }

  static open(archivePath: string): ReadOnlyAsarArchive {
    const fd = openSync(archivePath, "r");
    try {
      const initialStat = fstatSync(fd);
      const sizePickle = readExactly(fd, asarPicklePrefixSize, 0, "header size");
      if (sizePickle.readUInt32LE(0) !== 4) {
        throw new Error("Unsupported app.asar size pickle format.");
      }
      const headerSize = sizePickle.readUInt32LE(4);
      if (
        headerSize < asarPicklePrefixSize ||
        headerSize > asarMaximumHeaderSize ||
        asarPicklePrefixSize + headerSize > initialStat.size
      ) {
        throw new Error(`Invalid app.asar header size ${headerSize}.`);
      }
      const headerPickle = readExactly(
        fd,
        headerSize,
        asarPicklePrefixSize,
        "header",
      );
      const payloadSize = headerPickle.readUInt32LE(0);
      const jsonSize = headerPickle.readUInt32LE(4);
      if (
        payloadSize + 4 > headerSize ||
        jsonSize > payloadSize - 4 ||
        asarPicklePrefixSize + jsonSize > headerSize
      ) {
        throw new Error("Invalid app.asar header pickle lengths.");
      }
      let header: AsarHeaderEntry;
      try {
        header = JSON.parse(
          headerPickle.subarray(asarPicklePrefixSize, asarPicklePrefixSize + jsonSize)
            .toString("utf8"),
        ) as AsarHeaderEntry;
      } catch (error) {
        throw new Error(
          `Invalid app.asar header JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const dataOffset = asarPicklePrefixSize + headerSize;
      const files = flattenAsarFiles(
        header,
        initialStat.size,
        dataOffset,
      );
      return new ReadOnlyAsarArchive(
        archivePath,
        fd,
        initialStat,
        dataOffset,
        files,
      );
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  readFile(entry: ReadOnlyAsarFile): Buffer {
    if (this.closed) {
      throw new Error("app.asar archive is already closed.");
    }
    let content: Buffer;
    if (entry.unpacked) {
      content = readFileSync(
        join(`${this.archivePath}.unpacked`, ...entry.path.split("/")),
      );
    } else {
      content = readExactly(
        this.fd,
        entry.size,
        this.dataOffset + entry.offset,
        entry.path,
      );
    }
    if (content.length !== entry.size) {
      throw new Error(`Unexpected app.asar file size for ${entry.path}.`);
    }
    if (
      entry.integrity?.algorithm?.toUpperCase() === "SHA256" &&
      entry.integrity.hash
    ) {
      const actualHash = createHash("sha256").update(content).digest("hex");
      if (actualHash.toLowerCase() !== entry.integrity.hash.toLowerCase()) {
        throw new Error(`app.asar integrity check failed for ${entry.path}.`);
      }
    }
    return content;
  }

  sha256(): string {
    if (this.closed) {
      throw new Error("app.asar archive is already closed.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(asarHashBufferSize);
    let position = 0;
    while (position < this.initialStat.size) {
      const length = Math.min(buffer.length, this.initialStat.size - position);
      const bytesRead = readSync(this.fd, buffer, 0, length, position);
      if (bytesRead <= 0) {
        throw new Error("Unexpected end of app.asar while hashing archive.");
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  }

  assertUnchanged(): void {
    const finalDescriptorStat = fstatSync(this.fd);
    const finalPathStat = statSync(this.archivePath);
    if (
      !sameFileSnapshot(this.initialStat, finalDescriptorStat) ||
      !sameFileSnapshot(this.initialStat, finalPathStat)
    ) {
      throw new Error("app.asar changed during compatibility inspection.");
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    closeSync(this.fd);
  }
}

export function readOnlyFileSnapshotSync(path: string): ReadOnlyFileSnapshot {
  const fd = openSync(path, "r");
  try {
    const initialStat = fstatSync(fd);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(asarHashBufferSize);
    let position = 0;
    while (position < initialStat.size) {
      const length = Math.min(buffer.length, initialStat.size - position);
      const bytesRead = readSync(fd, buffer, 0, length, position);
      if (bytesRead <= 0) {
        throw new Error(`Unexpected end of file while hashing ${path}.`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const finalDescriptorStat = fstatSync(fd);
    const finalPathStat = statSync(path);
    if (
      !sameFileSnapshot(initialStat, finalDescriptorStat) ||
      !sameFileSnapshot(initialStat, finalPathStat)
    ) {
      throw new Error(`File changed during read-only inspection: ${path}.`);
    }
    return {
      sha256: hash.digest("hex"),
      size: initialStat.size,
      mtimeMs: initialStat.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
}

export function readOnlyFileContentSnapshotSync(
  path: string,
): ReadOnlyFileContentSnapshot {
  const fd = openSync(path, "r");
  try {
    const initialStat = fstatSync(fd);
    if (!Number.isSafeInteger(initialStat.size) || initialStat.size < 0) {
      throw new Error(`Invalid file size while reading ${path}.`);
    }
    const content = readExactly(fd, initialStat.size, 0, path);
    const finalDescriptorStat = fstatSync(fd);
    const finalPathStat = statSync(path);
    if (
      !sameFileSnapshot(initialStat, finalDescriptorStat) ||
      !sameFileSnapshot(initialStat, finalPathStat)
    ) {
      throw new Error(`File changed during read-only inspection: ${path}.`);
    }
    return {
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: initialStat.size,
      mtimeMs: initialStat.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
}
