export function main(argv = process.argv.slice(2), write: (message: string) => void = console.log): number {
  if (argv.includes("--list")) {
    write("No desktop E2E scenarios are registered yet.");
    return 0;
  }

  write("Desktop E2E harness skeleton is installed. Use --list to inspect scenarios.");
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
