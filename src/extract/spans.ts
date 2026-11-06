/**
 * Where in each file a route registration writes its path: the path argument of `app.get("/x", handler)`, the
 * arguments of a decorator or a mapping annotation. A string that starts there is the registration, not a request,
 * even when the file is also one of its component's call files; a request in the handler beside it is outside.
 */
export class Spans {
  private readonly byFile = new Map<string, Array<[number, number]>>();

  add(file: string, start: number, end: number): void {
    (this.byFile.get(file) ?? this.byFile.set(file, []).get(file)!).push([start, end]);
  }

  holds(file: string, offset: number): boolean {
    return (this.byFile.get(file) ?? []).some(([start, end]) => offset >= start && offset < end);
  }
}
