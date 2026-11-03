// Never let an isolated application discover the host's authenticated GitHub CLI.
if (process.argv[2] === "--version") {
  console.log("gh version 2.99.0 (Clanky sanity fixture)");
} else {
  console.error("GitHub is not configured in the isolated sanity fixture");
  process.exitCode = 1;
}
