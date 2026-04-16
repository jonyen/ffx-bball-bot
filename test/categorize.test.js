import { describe, test, expect } from 'vitest';
import { categorize } from '../src/reactionHandler/categorize.js';

const BOT = 'UBOT';

function reaction(name, users) {
  return { name, users };
}

describe('categorize', () => {
  test('empty reactions yields empty roster', () => {
    expect(categorize([], BOT)).toEqual({ in: [], out: [], maybe: [] });
  });

  test('basketball emoji marks user In', () => {
    const result = categorize([reaction('basketball', ['U1'])], BOT);
    expect(result).toEqual({ in: ['U1'], out: [], maybe: [] });
  });

  test('+1 marks user In', () => {
    const result = categorize([reaction('+1', ['U1'])], BOT);
    expect(result.in).toEqual(['U1']);
  });

  test('white_check_mark marks user In', () => {
    const result = categorize([reaction('white_check_mark', ['U1'])], BOT);
    expect(result.in).toEqual(['U1']);
  });

  test('x marks user Out', () => {
    const result = categorize([reaction('x', ['U1'])], BOT);
    expect(result).toEqual({ in: [], out: ['U1'], maybe: [] });
  });

  test('-1 marks user Out', () => {
    const result = categorize([reaction('-1', ['U1'])], BOT);
    expect(result.out).toEqual(['U1']);
  });

  test('unknown emoji marks user Maybe', () => {
    const result = categorize([reaction('thinking_face', ['U1'])], BOT);
    expect(result).toEqual({ in: [], out: [], maybe: ['U1'] });
  });

  test('filters out the bot user from every category', () => {
    const result = categorize(
      [
        reaction('basketball', [BOT, 'U1']),
        reaction('x', [BOT]),
        reaction('eyes', [BOT]),
      ],
      BOT,
    );
    expect(result).toEqual({ in: ['U1'], out: [], maybe: [] });
  });

  test('user in both In and Maybe is only counted as In', () => {
    const result = categorize(
      [reaction('basketball', ['U1']), reaction('eyes', ['U1'])],
      BOT,
    );
    expect(result).toEqual({ in: ['U1'], out: [], maybe: [] });
  });

  test('user in both Out and Maybe is only counted as Out', () => {
    const result = categorize(
      [reaction('x', ['U1']), reaction('eyes', ['U1'])],
      BOT,
    );
    expect(result).toEqual({ in: [], out: ['U1'], maybe: [] });
  });

  test('user in both In and Out resolves to In', () => {
    const result = categorize(
      [reaction('basketball', ['U1']), reaction('x', ['U1'])],
      BOT,
    );
    expect(result).toEqual({ in: ['U1'], out: [], maybe: [] });
  });

  test('multiple users across categories', () => {
    const result = categorize(
      [
        reaction('basketball', ['U1', 'U2']),
        reaction('+1', ['U3']),
        reaction('x', ['U4']),
        reaction('-1', ['U5']),
        reaction('eyes', ['U6']),
        reaction('thinking_face', ['U7']),
      ],
      BOT,
    );
    expect(result.in.sort()).toEqual(['U1', 'U2', 'U3']);
    expect(result.out.sort()).toEqual(['U4', 'U5']);
    expect(result.maybe.sort()).toEqual(['U6', 'U7']);
  });

  test('deduplicates a user who appears twice in the same category', () => {
    const result = categorize(
      [reaction('basketball', ['U1']), reaction('+1', ['U1'])],
      BOT,
    );
    expect(result.in).toEqual(['U1']);
  });
});
