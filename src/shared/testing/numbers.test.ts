import { describe, expect, it } from 'vitest';
import { nearly, nearlyObject } from './numbers.ts';

describe('nearly', () => {
  it('lets a fraction differ in its last bit', () => {
    expect(75.79019820701537).toEqual(nearly(75.79019820701538));
    expect(-1.0145122685342076).toEqual(nearly(-1.0145122685342074));
    expect(4.2e-7 + 1e-22).toEqual(nearly(4.2e-7));
  });

  it('still tells fractions apart past 12 significant digits', () => {
    expect(75.7901982071).not.toEqual(nearly(75.79019820701538));
    expect(4.2000001e-7).not.toEqual(nearly(4.2e-7));
  });

  it('keeps integers and everything else exact', () => {
    expect(1601).not.toEqual(nearly(1600));
    expect({ ply: 23, cls: 'inaccuracy', holes: [null, 0.5] }).toEqual(
      nearly({ ply: 23, cls: 'inaccuracy', holes: [null, 0.5] }),
    );
    expect({ ply: 23, cls: 'mistake' }).not.toEqual(nearly({ ply: 23, cls: 'inaccuracy' }));
  });

  it('matches part of an object', () => {
    expect({ accuracy: 75.79019820701537, san: 'd4' }).toMatchObject(
      nearlyObject({ accuracy: 75.79019820701538 }),
    );
  });
});
