import { CString, dlopen, type Pointer, read } from "bun:ffi";
import {
  constants,
  fstatSync,
  ftruncateSync,
  readSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";

const supported = process.platform === "darwin" || process.platform === "linux";
if (!supported)
  throw new Error(
    "LOCAL_STORAGE_PATH requires openat support on macOS or Linux",
  );

const errnoSymbol =
  process.platform === "darwin" ? "__error" : "__errno_location";
const nativeDefinitions = {
  open: { args: ["cstring", "i32", "u32"], returns: "i32" },
  openat: { args: ["i32", "cstring", "i32", "u32"], returns: "i32" },
  mkdirat: { args: ["i32", "cstring", "u32"], returns: "i32" },
  linkat: {
    args: ["i32", "cstring", "i32", "cstring", "i32"],
    returns: "i32",
  },
  unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
  renameat: { args: ["i32", "cstring", "i32", "cstring"], returns: "i32" },
  fstatat: { args: ["i32", "cstring", "ptr", "i32"], returns: "i32" },
  fchmod: { args: ["i32", "u32"], returns: "i32" },
  fsync: { args: ["i32"], returns: "i32" },
  flock: { args: ["i32", "i32"], returns: "i32" },
  fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
  dup: { args: ["i32"], returns: "i32" },
  fdopendir: { args: ["i32"], returns: "ptr" },
  readdir: { args: ["ptr"], returns: "ptr" },
  closedir: { args: ["ptr"], returns: "i32" },
  memset: { args: ["ptr", "i32", "usize"], returns: "ptr" },
  telldir: { args: ["ptr"], returns: "i64" },
  seekdir: { args: ["ptr", "i64"], returns: "void" },
  close: { args: ["i32"], returns: "i32" },
  [errnoSymbol]: { args: [], returns: "ptr" },
  ...(process.platform === "darwin"
    ? {
        fclonefileat: {
          args: ["i32", "i32", "cstring", "u32"],
          returns: "i32",
        },
        fgetxattr: {
          args: ["i32", "cstring", "ptr", "usize", "u32", "i32"],
          returns: "isize",
        },
        fsetxattr: {
          args: ["i32", "cstring", "ptr", "usize", "u32", "i32"],
          returns: "i32",
        },
      }
    : {
        fgetxattr: {
          args: ["i32", "cstring", "ptr", "usize"],
          returns: "isize",
        },
        fsetxattr: {
          args: ["i32", "cstring", "ptr", "usize", "i32"],
          returns: "i32",
        },
        renameat2: {
          args: ["i32", "cstring", "i32", "cstring", "u32"],
          returns: "i32",
        },
      }),
} as const;
const libc = dlopen(
  process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
  nativeDefinitions as never,
);

type NativeSymbols = {
  open: (path: Uint8Array, flags: number, mode: number) => number;
  openat: (
    directory: number,
    path: Uint8Array,
    flags: number,
    mode: number,
  ) => number;
  mkdirat: (directory: number, path: Uint8Array, mode: number) => number;
  linkat: (
    sourceDirectory: number,
    source: Uint8Array,
    targetDirectory: number,
    target: Uint8Array,
    flags: number,
  ) => number;
  unlinkat: (directory: number, path: Uint8Array, flags: number) => number;
  renameat: (
    sourceDirectory: number,
    source: Uint8Array,
    targetDirectory: number,
    target: Uint8Array,
  ) => number;
  renameat2?: (
    sourceDirectory: number,
    source: Uint8Array,
    targetDirectory: number,
    target: Uint8Array,
    flags: number,
  ) => number;
  fstatat: (
    directory: number,
    path: Uint8Array,
    metadata: Uint8Array,
    flags: number,
  ) => number;
  fchmod: (descriptor: number, mode: number) => number;
  fsync: (descriptor: number) => number;
  flock: (descriptor: number, operation: number) => number;
  fcntl: (descriptor: number, command: number, argument: number) => number;
  dup: (descriptor: number) => number;
  fdopendir: (descriptor: number) => Pointer | null;
  readdir: (directory: Pointer) => Pointer | null;
  closedir: (directory: Pointer) => number;
  memset: (pointer: Pointer, value: number, size: number) => Pointer;
  telldir: (directory: Pointer) => bigint;
  seekdir: (directory: Pointer, offset: bigint) => void;
  fclonefileat?: (
    source: number,
    targetDirectory: number,
    target: Uint8Array,
    flags: number,
  ) => number;
  close: (descriptor: number) => number;
  errno: () => number;
};

const raw = libc.symbols as unknown as Record<
  string,
  (...args: never[]) => unknown
>;
const native: NativeSymbols = {
  open: raw.open as NativeSymbols["open"],
  openat: raw.openat as NativeSymbols["openat"],
  mkdirat: raw.mkdirat as NativeSymbols["mkdirat"],
  linkat: raw.linkat as NativeSymbols["linkat"],
  unlinkat: raw.unlinkat as NativeSymbols["unlinkat"],
  renameat: raw.renameat as NativeSymbols["renameat"],
  renameat2: raw.renameat2 as NativeSymbols["renameat2"],
  fstatat: raw.fstatat as NativeSymbols["fstatat"],
  fchmod: raw.fchmod as NativeSymbols["fchmod"],
  fsync: raw.fsync as NativeSymbols["fsync"],
  flock: raw.flock as NativeSymbols["flock"],
  fcntl: raw.fcntl as NativeSymbols["fcntl"],
  dup: raw.dup as NativeSymbols["dup"],
  fdopendir: raw.fdopendir as NativeSymbols["fdopendir"],
  readdir: raw.readdir as NativeSymbols["readdir"],
  closedir: raw.closedir as NativeSymbols["closedir"],
  memset: raw.memset as NativeSymbols["memset"],
  telldir: raw.telldir as NativeSymbols["telldir"],
  seekdir: raw.seekdir as NativeSymbols["seekdir"],
  fclonefileat: raw.fclonefileat as NativeSymbols["fclonefileat"],
  close: raw.close as NativeSymbols["close"],
  errno: () => {
    const pointer = raw[errnoSymbol]?.();
    if (typeof pointer !== "number" && typeof pointer !== "bigint")
      throw new Error("Could not read native filesystem errno");
    return read.i32(pointer as Pointer);
  },
};

const requiredFlag = (name: keyof typeof constants): number => {
  const value = constants[name];
  if (typeof value !== "number")
    throw new Error(`LOCAL_STORAGE_PATH requires ${String(name)}`);
  return value;
};

// Linux open flags differ by CPU architecture. Node's constants come from the
// active libc headers, so use them rather than encoding x86 values.
const flags = {
  readOnly: requiredFlag("O_RDONLY"),
  writeOnly: requiredFlag("O_WRONLY"),
  readWrite: requiredFlag("O_RDWR"),
  create: requiredFlag("O_CREAT"),
  exclusive: requiredFlag("O_EXCL"),
  noFollow: requiredFlag("O_NOFOLLOW"),
  directory: requiredFlag("O_DIRECTORY"),
  nonBlock: requiredFlag("O_NONBLOCK"),
};

const ERRNO = {
  interrupted: 4,
  missing: 2,
  exists: 17,
  isDirectory: 21,
  invalid: 22,
  unimplemented: 38,
  unsupported: 95,
} as const;

// O_TMPFILE is 020000000 plus O_DIRECTORY on every Linux architecture.
const TEMPORARY_INODE = 0x400000;
const RENAME_NOREPLACE = 1;

// A kernel without O_TMPFILE reports its refusal in one of these ways. gVisor
// (runsc), which merv runs every verification inside, answers EISDIR on its
// overlay root and EOPNOTSUPP on its tmpfs.
const ANONYMOUS_REFUSED: readonly number[] = [
  ERRNO.isDirectory,
  ERRNO.unsupported,
  ERRNO.invalid,
  ERRNO.unimplemented,
];

const cString = (value: string): Uint8Array =>
  Buffer.from(`${value}\0`, "utf8");

export class NativeStorageError extends Error {
  readonly errno: number;
  readonly code: string;

  constructor(operation: string, errno: number) {
    const code =
      errno === ERRNO.missing
        ? "ENOENT"
        : errno === ERRNO.exists
          ? "EEXIST"
          : `ERRNO_${errno}`;
    super(`${operation} failed (${code})`);
    this.name = "NativeStorageError";
    this.errno = errno;
    this.code = code;
  }
}

const result = (operation: string, invoke: () => number): number => {
  while (true) {
    const value = invoke();
    if (value >= 0) return value;
    const errno = native.errno();
    if (errno === ERRNO.interrupted) continue;
    throw new NativeStorageError(operation, errno);
  }
};

export const close = (descriptor: number): void => {
  if (descriptor >= 0) native.close(descriptor);
};

const closeOnExec = (descriptor: number): number => {
  try {
    result("mark storage descriptor close-on-exec", () =>
      native.fcntl(descriptor, 2, 1),
    );
    return descriptor;
  } catch (error) {
    close(descriptor);
    throw error;
  }
};

const directoryFlags = flags.readOnly | flags.directory | flags.noFollow;

const TYPE_MASK = 0o170000;
const DIRECTORY_TYPE = 0o040000;

// gVisor (runsc) opens a symlink to a directory even with O_NOFOLLOW, where a
// stock kernel answers ENOTDIR. So a directory descriptor is trusted only when
// the unfollowed name is that very inode; a swap between the two calls changes
// the identity and fails closed.
const openSubdirectory = (
  parent: number,
  name: string,
  operation: string,
): number => {
  const descriptor = closeOnExec(
    result(operation, () =>
      native.openat(parent, cString(name), directoryFlags, 0),
    ),
  );
  try {
    const entry = pathMetadataAt(parent, name);
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      (entry.mode & TYPE_MASK) !== DIRECTORY_TYPE ||
      !opened.isDirectory() ||
      entry.device !== opened.dev ||
      entry.inode !== opened.ino
    )
      throw new Error("Storage directory is not its own non-symlink name");
    return descriptor;
  } catch (error) {
    close(descriptor);
    throw error;
  }
};

const openCanonicalDirectory = (path: string, create: boolean): number => {
  let current = closeOnExec(
    result("open filesystem root", () =>
      native.open(cString("/"), directoryFlags, 0),
    ),
  );
  try {
    for (const component of path.split("/").filter(Boolean)) {
      let next: number;
      try {
        next = openSubdirectory(
          current,
          component,
          "open storage root component",
        );
      } catch (error) {
        if (
          !create ||
          !(error instanceof NativeStorageError) ||
          error.code !== "ENOENT"
        )
          throw error;
        result("create storage root component", () =>
          native.mkdirat(current, cString(component), 0o700),
        );
        next = openSubdirectory(
          current,
          component,
          "open created storage root component",
        );
        result("sync created storage root", () => native.fsync(next));
        result("sync storage root parent", () => native.fsync(current));
      }
      close(current);
      current = next;
    }
    return current;
  } catch (error) {
    close(current);
    throw error;
  }
};

export const openRoot = (root: string): number => {
  let target = resolve(root);
  // macOS exposes these fixed operating-system aliases as root-level symlinks.
  // Expand only this closed list before opening anything. Every component of
  // the resulting path is then traversed and, when necessary, created from a
  // stable parent descriptor with O_NOFOLLOW. No validation decision is made
  // from lstat/realpath of a mutable application-controlled pathname.
  if (process.platform === "darwin") {
    for (const alias of ["var", "tmp", "etc"] as const) {
      const prefix = `/${alias}`;
      if (target === prefix || target.startsWith(`${prefix}/`)) {
        target = `/private/${alias}${target.slice(prefix.length)}`;
        break;
      }
    }
  }
  const descriptor = openCanonicalDirectory(target, true);
  const entry = fstatSync(descriptor, { bigint: true });
  const uid = process.getuid?.();
  if (
    !entry.isDirectory() ||
    uid === undefined ||
    entry.uid !== BigInt(uid) ||
    (entry.mode & 0o777n) !== 0o700n
  ) {
    close(descriptor);
    throw new Error("LOCAL_STORAGE_PATH must be a private owned directory");
  }
  return descriptor;
};

export const openDirectory = (
  parent: number,
  name: string,
  create: boolean,
): number => {
  try {
    return openSubdirectory(parent, name, "open storage directory");
  } catch (error) {
    if (
      !(error instanceof NativeStorageError) ||
      error.code !== "ENOENT" ||
      !create
    )
      throw error;
    try {
      result("create storage directory", () =>
        native.mkdirat(parent, cString(name), 0o700),
      );
    } catch (mkdirError) {
      if (
        !(mkdirError instanceof NativeStorageError) ||
        mkdirError.code !== "EEXIST"
      )
        throw mkdirError;
    }
    const created = openSubdirectory(
      parent,
      name,
      "open created storage directory",
    );
    try {
      // Persist the new entry in its parent and the empty directory inode
      // before any descendant publication can become visible.
      syncDirectory(created);
      syncDirectory(parent);
      return created;
    } catch (error) {
      close(created);
      throw error;
    }
  }
};

export const openFile = (
  parent: number,
  name: string,
  mode: "read" | "write" | "exclusive",
  afterCreate?: () => void,
): number => {
  const openFlags =
    mode === "read"
      ? flags.readOnly | flags.nonBlock | flags.noFollow
      : (mode === "exclusive" ? flags.readWrite : flags.writeOnly) |
        flags.nonBlock |
        flags.noFollow |
        (mode === "exclusive" ? flags.create | flags.exclusive : 0);
  const descriptor = closeOnExec(
    result(`open storage file (${mode})`, () =>
      // openat is variadic in libc. Passing zero keeps the creation window
      // fail-closed even on FFI ABIs that do not reliably marshal variadic
      // mode_t; the fixed-signature fchmod below installs the final 0600 mode
      // before bytes are written or the private inode is linked.
      native.openat(parent, cString(name), openFlags, 0),
    ),
  );
  try {
    if (mode === "exclusive") {
      afterCreate?.();
      result("restrict storage file permissions", () =>
        native.fchmod(descriptor, 0o600),
      );
    }
    validateRegularFile(descriptor);
    return descriptor;
  } catch (error) {
    close(descriptor);
    throw error;
  }
};

type PathMetadata = FileIdentity & {
  links: bigint;
  mode: number;
  regular: boolean;
  uid: number;
};

const pathMetadataAt = (parent: number, name: string): PathMetadata => {
  const bytes = Buffer.alloc(256);
  result("inspect storage path without following links", () =>
    native.fstatat(
      parent,
      cString(name),
      bytes,
      process.platform === "darwin" ? 0x0020 : 0x0100,
    ),
  );
  if (process.platform === "darwin")
    return {
      device: BigInt(bytes.readInt32LE(0)),
      inode: bytes.readBigUInt64LE(8),
      mode: bytes.readUInt16LE(4),
      links: BigInt(bytes.readUInt16LE(6)),
      uid: bytes.readUInt32LE(16),
      regular: (bytes.readUInt16LE(4) & 0xf000) === 0x8000,
    };
  if (process.arch === "arm64")
    return {
      device: bytes.readBigUInt64LE(0),
      inode: bytes.readBigUInt64LE(8),
      mode: bytes.readUInt32LE(16),
      links: BigInt(bytes.readUInt32LE(20)),
      uid: bytes.readUInt32LE(24),
      regular: (bytes.readUInt32LE(16) & 0xf000) === 0x8000,
    };
  if (process.arch === "x64")
    return {
      device: bytes.readBigUInt64LE(0),
      inode: bytes.readBigUInt64LE(8),
      mode: bytes.readUInt32LE(24),
      links: bytes.readBigUInt64LE(16),
      uid: bytes.readUInt32LE(28),
      regular: (bytes.readUInt32LE(24) & 0xf000) === 0x8000,
    };
  throw new Error("Private storage recovery is unsupported on this CPU");
};

export const discardPrivateCreationRemnant = (
  parent: number,
  name: string,
  quarantine: string,
): boolean => {
  let candidate: PathMetadata;
  try {
    candidate = pathMetadataAt(parent, name);
  } catch (error) {
    if (error instanceof NativeStorageError && error.code === "ENOENT")
      return false;
    throw error;
  }
  const exactRemnant =
    candidate.regular &&
    currentUid !== undefined &&
    candidate.uid === currentUid &&
    candidate.links === 1n &&
    (candidate.mode & 0o777) === 0;
  if (!exactRemnant) return false;

  replaceFile(parent, name, parent, quarantine);
  const isolated = pathMetadataAt(parent, quarantine);
  if (
    !isolated.regular ||
    isolated.uid !== candidate.uid ||
    isolated.links !== 1n ||
    (isolated.mode & 0o777) !== 0 ||
    isolated.device !== candidate.device ||
    isolated.inode !== candidate.inode
  )
    throw new Error("Private storage crash remnant changed during recovery");
  unlinkFile(parent, quarantine);
  syncDirectory(parent);
  return true;
};

const currentUid = process.getuid?.();

export type FileIdentity = {
  device: bigint;
  inode: bigint;
};

export const validateRegularFile = (
  descriptor: number,
  expectedLinks = 1n,
): FileIdentity => {
  const entry = fstatSync(descriptor, { bigint: true });
  if (
    !entry.isFile() ||
    currentUid === undefined ||
    entry.uid !== BigInt(currentUid) ||
    entry.nlink !== expectedLinks ||
    (entry.mode & 0o777n) !== 0o600n
  )
    throw new Error(
      "Local storage object must be a private, owned, single-link regular file",
    );
  return { device: entry.dev, inode: entry.ino };
};

export const truncateFile = (descriptor: number, expectedLinks = 1n): void => {
  validateRegularFile(descriptor, expectedLinks);
  ftruncateSync(descriptor, 0);
};

export const writeExact = (descriptor: number, bytes: Uint8Array): number => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (written <= 0) throw new Error("Local storage write made no progress");
    offset += written;
  }
  return offset;
};

const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export const readVerified = (
  descriptor: number,
  expected: {
    links: bigint;
    maxBytes: number;
    size?: number;
    sha256?: string;
  },
): Uint8Array => {
  const before = fstatSync(descriptor, { bigint: true });
  validateRegularFile(descriptor, expected.links);
  const size = Number(before.size);
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > expected.maxBytes ||
    (expected.size !== undefined && size !== expected.size)
  )
    throw new Error("Local storage object size does not match authority");
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, bytes, offset, size - offset, offset);
    if (count <= 0)
      throw new Error("Local storage object ended before its durable size");
    offset += count;
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs
  )
    throw new Error("Local storage object changed during snapshot");
  validateRegularFile(descriptor, expected.links);
  if (expected.sha256 !== undefined && sha256(bytes) !== expected.sha256)
    throw new Error("Local storage object digest does not match authority");
  return bytes;
};

export const readPrefixVerified = (
  descriptor: number,
  maxBytes: number,
  expectedLinks: bigint,
): Uint8Array => {
  const before = fstatSync(descriptor, { bigint: true });
  validateRegularFile(descriptor, expectedLinks);
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error("Local storage object size is invalid");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("Local storage prefix limit is invalid");
  const length: number = Math.min(size, maxBytes);
  const bytes = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(descriptor, bytes, offset, length - offset, offset);
    if (count <= 0)
      throw new Error("Local storage object ended before its durable size");
    offset += count;
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs
  )
    throw new Error("Local storage object changed during prefix snapshot");
  validateRegularFile(descriptor, expectedLinks);

  return bytes;
};

export const syncFile = (descriptor: number): void => {
  result("sync storage file", () => native.fsync(descriptor));
};

export const syncDirectory = (descriptor: number): void => {
  result("sync storage directory", () => native.fsync(descriptor));
};

export const setFileMode = (descriptor: number, mode: 0o600 | 0o700): void => {
  result("set storage file permissions", () => native.fchmod(descriptor, mode));
};

export const linkCount = (descriptor: number): bigint =>
  fstatSync(descriptor, { bigint: true }).nlink;

export const modifiedAtMs = (descriptor: number): number =>
  Number(fstatSync(descriptor, { bigint: true }).mtimeMs);

export const sameIdentity = (
  descriptor: number,
  identity: FileIdentity,
): boolean => {
  const entry = fstatSync(descriptor, { bigint: true });
  return entry.dev === identity.device && entry.ino === identity.inode;
};

export type TemporaryFile = {
  descriptor: number;
  directory: number;
  // The name the temporary still answers to, or null once it is anonymous.
  name: string | null;
};

// Remembered for the process: a filesystem that refuses O_TMPFILE never starts
// allowing it, so only the first publication pays a failed openat. Tests clear
// it to exercise the portable path on a kernel that does have O_TMPFILE.
export const anonymousTemporaries = { supported: process.platform === "linux" };

export const temporaryLinks = (temporary: TemporaryFile): bigint =>
  temporary.name === null ? 0n : 1n;

const openAnonymousInode = (directory: number): number | null => {
  if (!anonymousTemporaries.supported) return null;
  let descriptor: number;
  try {
    // Unlike unlinking a named file, this produces an inode that the
    // unprivileged /proc/self/fd linkat fallback can publish exactly.
    descriptor = closeOnExec(
      result("create anonymous storage inode", () =>
        native.openat(
          directory,
          cString("."),
          flags.readWrite | flags.directory | TEMPORARY_INODE,
          0,
        ),
      ),
    );
  } catch (error) {
    if (
      !(error instanceof NativeStorageError) ||
      !ANONYMOUS_REFUSED.includes(error.errno)
    )
      throw error;
    anonymousTemporaries.supported = false;
    return null;
  }
  try {
    result("restrict anonymous storage inode permissions", () =>
      native.fchmod(descriptor, 0o600),
    );
    validateRegularFile(descriptor, 0n);
    return descriptor;
  } catch (error) {
    close(descriptor);
    throw error;
  }
};

export const createTemporaryFile = (directory: number): TemporaryFile => {
  const anonymous = openAnonymousInode(directory);
  if (anonymous !== null)
    return { descriptor: anonymous, directory, name: null };

  const name = `artifact-${crypto.randomUUID()}.tmp`;
  const descriptor = openFile(directory, name, "exclusive");
  try {
    // macOS publishes by cloning the held descriptor, so the name is dropped at
    // once and the inode is reachable only through that descriptor. Linux
    // cannot link an unlinked inode back into the namespace, so where the
    // kernel also refuses O_TMPFILE the temporary keeps its unguessable 0600
    // name until renameat2(RENAME_NOREPLACE) installs it in one atomic step
    // that cannot overwrite and leaves the published object single-linked. The
    // exclusive lock stops concurrent cleanup collecting a live publisher.
    if (process.platform === "darwin") {
      unlinkFile(directory, name);
      const entry = fstatSync(descriptor, { bigint: true });
      if (entry.nlink !== 0n)
        throw new Error("Local storage temporary inode remained name-linked");
      return { descriptor, directory, name: null };
    }
    if (!tryExclusiveLock(descriptor))
      throw new Error("Local storage temporary was already held");
    validateRegularFile(descriptor);
    return { descriptor, directory, name };
  } catch (error) {
    close(descriptor);
    unlinkFile(directory, name, true);
    throw error;
  }
};

export const discardTemporary = (temporary: TemporaryFile): void => {
  close(temporary.descriptor);
  if (temporary.name !== null)
    unlinkFile(temporary.directory, temporary.name, true);
};

export const installTemporary = (
  temporary: TemporaryFile,
  targetDirectory: number,
  target: string,
): "created" | "exists" => {
  const { descriptor, directory, name } = temporary;
  try {
    if (name !== null) {
      const rename = native.renameat2;
      if (!rename)
        throw new Error("Named storage temporaries require renameat2");
      result("install exact storage temporary", () =>
        rename(
          directory,
          cString(name),
          targetDirectory,
          cString(target),
          RENAME_NOREPLACE,
        ),
      );
    } else if (process.platform === "darwin") {
      if (!native.fclonefileat)
        throw new Error("Darwin descriptor cloning is unavailable");
      result(
        "clone exact storage inode",
        () =>
          native.fclonefileat?.(
            descriptor,
            targetDirectory,
            cString(target),
            0,
          ) ?? -1,
      );
    } else {
      try {
        result("link exact storage inode", () =>
          native.linkat(
            descriptor,
            cString(""),
            targetDirectory,
            cString(target),
            0x1000,
          ),
        );
      } catch (error) {
        if (
          !(error instanceof NativeStorageError) ||
          ![1, 2, 22].includes(error.errno)
        )
          throw error;
        result("link exact proc descriptor", () =>
          native.linkat(
            -100,
            cString(`/proc/self/fd/${descriptor}`),
            targetDirectory,
            cString(target),
            0x400,
          ),
        );
      }
    }
    return "created";
  } catch (error) {
    if (error instanceof NativeStorageError && error.code === "EEXIST")
      return "exists";
    throw error;
  }
};

export const identityAt = (parent: number, name: string): FileIdentity => {
  const descriptor = openFile(parent, name, "read");
  try {
    return validateRegularFile(descriptor);
  } finally {
    close(descriptor);
  }
};

export const tryExclusiveLock = (descriptor: number): boolean => {
  const value = native.flock(descriptor, 2 | 4);
  if (value === 0) return true;
  const errno = native.errno();
  if (errno === 11 || errno === 35) return false;
  throw new NativeStorageError("lock storage object", errno);
};

const CURSOR_ATTRIBUTE =
  process.platform === "darwin"
    ? "com.quaz.temp-cleanup-cursor"
    : "user.quaz.temp-cleanup-cursor";

export const readDirectoryCursor = (descriptor: number): bigint => {
  const buffer = Buffer.alloc(32);
  const readAttribute = raw.fgetxattr as unknown as (
    descriptor: number,
    name: Uint8Array,
    value: Uint8Array,
    size: number,
    positionOrOptions?: number,
    options?: number,
  ) => number | bigint;
  const length =
    process.platform === "darwin"
      ? readAttribute(
          descriptor,
          cString(CURSOR_ATTRIBUTE),
          buffer,
          buffer.byteLength,
          0,
          0,
        )
      : readAttribute(
          descriptor,
          cString(CURSOR_ATTRIBUTE),
          buffer,
          buffer.byteLength,
        );
  if (length < 0) {
    const errno = native.errno();
    if (errno === (process.platform === "darwin" ? 93 : 61)) return 0n;
    throw new NativeStorageError("read storage cleanup cursor", errno);
  }
  const encoded = buffer.subarray(0, Number(length)).toString("utf8");
  return /^-?\d+$/.test(encoded) ? BigInt(encoded) : 0n;
};

export const writeDirectoryCursor = (
  descriptor: number,
  cursor: bigint,
): void => {
  const value = Buffer.from(String(cursor), "utf8");
  const writeAttribute = raw.fsetxattr as unknown as (
    descriptor: number,
    name: Uint8Array,
    value: Uint8Array,
    size: number,
    positionOrFlags?: number,
    flags?: number,
  ) => number;
  result("write storage cleanup cursor", () =>
    process.platform === "darwin"
      ? writeAttribute(
          descriptor,
          cString(CURSOR_ATTRIBUTE),
          value,
          value.byteLength,
          0,
          0,
        )
      : writeAttribute(
          descriptor,
          cString(CURSOR_ATTRIBUTE),
          value,
          value.byteLength,
          0,
        ),
  );
};

export const unlinkFile = (
  parent: number,
  name: string,
  missingOk = false,
): boolean => {
  try {
    result("unlink storage object", () =>
      native.unlinkat(parent, cString(name), 0),
    );
    return true;
  } catch (error) {
    if (
      missingOk &&
      error instanceof NativeStorageError &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
};

export const replaceFile = (
  sourceDirectory: number,
  source: string,
  targetDirectory: number,
  target: string,
): void => {
  result("replace storage object", () =>
    native.renameat(
      sourceDirectory,
      cString(source),
      targetDirectory,
      cString(target),
    ),
  );
};

export const listDirectory = (
  descriptor: number,
  limit: number,
  cursor = 0n,
): { names: string[]; cursor: bigint; eof: boolean } => {
  const duplicate = closeOnExec(
    result("duplicate storage directory", () => native.dup(descriptor)),
  );
  const directory = native.fdopendir(duplicate);
  if (!directory) {
    const errno = native.errno();
    close(duplicate);
    throw new NativeStorageError("open storage directory stream", errno);
  }
  const names: string[] = [];
  let eof = false;
  try {
    const errnoPointer = raw[errnoSymbol]?.();
    if (typeof errnoPointer !== "number" && typeof errnoPointer !== "bigint")
      throw new Error("Could not access directory stream errno");
    if (cursor !== 0n) native.seekdir(directory, cursor);
    while (names.length < limit) {
      native.memset(errnoPointer as Pointer, 0, 4);
      const entry = native.readdir(directory);
      if (!entry) {
        const errno = native.errno();
        if (errno !== 0)
          throw new NativeStorageError("read storage directory", errno);
        eof = true;
        break;
      }
      const nameOffset = process.platform === "darwin" ? 21 : 19;
      const name = new CString(entry, nameOffset).toString();
      if (name !== "." && name !== "..") names.push(name);
    }
    const next = BigInt(native.telldir(directory));
    return { names, cursor: eof ? 0n : next, eof };
  } finally {
    native.closedir(directory);
  }
};
