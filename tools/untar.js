// The regular files of an uncompressed tar archive, by name. Enough for npm's
// tarballs (plain ustar) and for GNU tar's output with paths under 100
// characters. Pax headers are skipped: they carry timestamps and xattrs here,
// and a path only when it is too long for the header, which GNU spells L.
module.exports = function untar(bytes) {
  const files = new Map();
  for (let at = 0; at + 512 <= bytes.length;) {
    const header = bytes.subarray(at, at + 512);
    const field = (start, length) => header.subarray(start, start + length).toString("latin1").replace(/\0.*$/s, "");
    const name = field(0, 100);
    if (!name) break;
    const size = parseInt(field(124, 12).trim(), 8);
    const prefix = field(345, 155);
    const type = field(156, 1);
    if (type === "0" || type === "") {
      files.set(prefix ? `${prefix}/${name}` : name, bytes.subarray(at + 512, at + 512 + size));
    } else if (type === "L" || type === "K") {
      // A long name for the next entry, which would otherwise land truncated.
      throw new Error(`tar entry ${name}: GNU long names are not supported`);
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
};
