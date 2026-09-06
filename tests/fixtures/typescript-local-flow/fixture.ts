export function assignments(input: number): number {
  let current = input;
  const first = current;
  current = first + 1;
  return current;
}

export function branches(flag: boolean, left: number, right: number): number {
  let selected = left;
  if (flag) {
    selected = right;
  }
  return selected;
}

export function aliases(input: number): number {
  const alias = input;
  return alias;
}

export function closures(input: number): () => number {
  const read = () => input;
  return read;
}

export class Holder {
  private value = 0;

  update(next: number): number {
    this.value = next;
    return this.value;
  }
}

function consume(value: number): number {
  return value;
}

export function argumentsAndReturns(input: number): number {
  const alias = input;
  return consume(alias);
}

export function sameStatement(input: { value: number }): number {
  const first = input,
    second = first;
  return second.value;
}

export function exceptional(input: number): number {
  let selected = input;
  consume(selected);
  try {
    selected = 1;
  } catch {
    selected = 2;
  }
  return selected;
}

export class CrossCallableHolder {
  private value = 0;

  update(next: number): void {
    this.value = next;
  }

  read(): number {
    return this.value;
  }
}

export function destructured({ left, right }: { left: number; right: number }, [head]: number[]): number {
  const { sum, product } = { sum: left + right, product: left * right };
  const [first, second = head] = [sum, product];
  return first + second;
}

export function elementWrites(values: number[], index: number): number {
  const copy = values;
  copy[index] = 1;
  return copy[0];
}

export function iterates(items: number[]): number {
  let total = 0;
  for (const item of items) {
    total += item;
  }
  return total;
}

export function shorthand(value: number): { doubled: number } {
  const doubled = value * 2;
  return { doubled };
}

export function guarded(risky: () => string): string {
  let status = 'start'; // eslint-disable-line no-useless-assignment -- Initial definition intentionally killed by the branches below.
  let finished = ''; // eslint-disable-line no-useless-assignment -- Initial definition intentionally killed by finally.
  try {
    risky();
    status = 'done';
  } catch (error) {
    status = String(error);
  } finally {
    finished = status;
  }
  return finished;
}
