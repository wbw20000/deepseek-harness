// Fake outbound command that exits 0 without reading stdin, used to prove the
// delivery survives a command that closes its read end mid-write.

setTimeout(() => process.exit(0), 150)
