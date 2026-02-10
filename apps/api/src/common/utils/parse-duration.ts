/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

const UNIT_TO_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

/**
 * Parses a human-readable duration string (e.g. "14d", "6h", "30m", "2w")
 * into milliseconds.
 *
 * Supported units: ms, s, m, h, d, w
 *
 * @throws Error if the format is invalid
 */
export function parseDuration(input: string): number {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|[smhdw])$/i)
  if (!match) {
    throw new Error(
      `Invalid duration format: "${input}". Expected a number followed by a unit (ms, s, m, h, d, w). Examples: "14d", "6h", "30m"`,
    )
  }

  const value = parseFloat(match[1])
  const unit = match[2].toLowerCase()

  return Math.round(value * UNIT_TO_MS[unit])
}
