// Fixture notification command that never reads stdin and never exits on its
// own: the deadline process-group kill is the only way it stops.

setInterval(() => {}, 60_000)
