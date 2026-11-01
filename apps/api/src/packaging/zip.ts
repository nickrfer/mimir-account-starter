import { open, type FileHandle } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';

export const ZIP_LIMIT_BYTES = 110 * 1024 * 1024;

export class PackagingError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface ZipEntry { path: string; data: Buffer; compress: boolean }

function dosStamp(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return { time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate() };
}

// Entries are written whole: callers hold at most one 5 MiB document at a time.
export class ZipFileWriter {
  private offset = 0;
  private readonly central: Buffer[] = [];
  private centralSize = 0;
  private constructor(private readonly handle: FileHandle, private readonly limit: number, private readonly stamp: { time: number; date: number }) {}

  static async create(path: string, at: Date, limit = ZIP_LIMIT_BYTES): Promise<ZipFileWriter> {
    return new ZipFileWriter(await open(path, 'wx', 0o600), limit, dosStamp(at));
  }

  async add(entry: ZipEntry): Promise<void> {
    const name = Buffer.from(entry.path, 'utf8');
    const data = entry.compress ? deflateRawSync(entry.data, { level: 9 }) : entry.data;
    const method = entry.compress ? 8 : 0, crc = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8); header.writeUInt16LE(this.stamp.time, 10); header.writeUInt16LE(this.stamp.date, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10); record.writeUInt16LE(this.stamp.time, 12); record.writeUInt16LE(this.stamp.date, 14);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(this.offset, 42);
    const projected = this.offset + header.length + name.length + data.length + this.centralSize + record.length + name.length + 22;
    if (projected > this.limit) throw new PackagingError('PACKAGE_TOO_LARGE');
    await this.handle.write(Buffer.concat([header, name, data]), 0, header.length + name.length + data.length, this.offset);
    this.offset += header.length + name.length + data.length;
    this.central.push(record, name); this.centralSize += record.length + name.length;
  }

  async finish(): Promise<number> {
    const directory = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.central.length / 2, 8); end.writeUInt16LE(this.central.length / 2, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(this.offset, 16);
    const tail = Buffer.concat([directory, end]);
    if (this.offset + tail.length > this.limit) throw new PackagingError('PACKAGE_TOO_LARGE');
    await this.handle.write(tail, 0, tail.length, this.offset);
    await this.handle.close();
    return this.offset + tail.length;
  }

  async abort(): Promise<void> { await this.handle.close().catch(() => undefined); }
}
