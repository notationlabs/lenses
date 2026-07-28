import { Array, Option, Record, Schema as S, pipe } from 'effect'

import { LensNode, Nodes, hostsOf, nodesForHost, targetsOf } from './catalog'
import { Selections } from './select'

// SCHEMA

export const Position = S.Struct({ x: S.Number, y: S.Number })
export type Position = typeof Position.Type

/** Card positions per site canvas: host -> lens name -> position. */
export const Positions = S.Record(S.String, S.Record(S.String, Position))
export type Positions = typeof Positions.Type

// LAYOUT CONSTANTS (mirroring the stylesheet so edges can be drawn from the Model)

export const CARD_WIDTH = 280
export const PORTAL_WIDTH = 200
const CARD_COLUMN_X = 40
const PORTAL_COLUMN_X = 430
const FIRST_CARD_Y = 64
const CARD_HEADER_HEIGHT = 34
const ROWS_PADDING_TOP = 4
const ROW_HEIGHT = 20
const PARAM_ROW_HEIGHT = 22
const CARD_GAP_ALLOWANCE = 96
const PORTAL_SPACING = 90

// WHAT RENDERS ON A SITE CANVAS

/** Lenses drawn as full cards on this host's canvas. */
export const cardNodes = (
  nodes: Nodes,
  host: string,
): ReadonlyArray<LensNode> =>
  Array.filter(nodesForHost(nodes, host), node => !node.isGhost)

/** Cross-site and ghost targets drawn as portal stand-ins on this host's canvas. */
export const portalNodes = (
  nodes: Nodes,
  host: string,
): ReadonlyArray<LensNode> => {
  const local = nodesForHost(nodes, host)
  const localNames = Array.map(local, node => node.name)
  return pipe(
    Array.flatMap(local, targetsOf),
    Array.dedupe,
    Array.map(target => Option.fromNullishOr(nodes[target])),
    Array.getSomes,
    Array.filter(
      target => !Array.contains(localNames, target.name) || target.isGhost,
    ),
  )
}

export const initialPositions = (nodes: Nodes): Positions => {
  const positions: Record<string, Record<string, Position>> = {}
  for (const host of hostsOf(nodes)) {
    const byName: Record<string, Position> = {}
    let y = FIRST_CARD_Y
    for (const node of cardNodes(nodes, host)) {
      byName[node.name] = { x: CARD_COLUMN_X, y }
      y +=
        CARD_GAP_ALLOWANCE +
        node.rows.length * ROW_HEIGHT +
        Record.size(node.params) * PARAM_ROW_HEIGHT
    }
    let portalY = FIRST_CARD_Y
    for (const portal of portalNodes(nodes, host)) {
      byName[portal.name] = { x: PORTAL_COLUMN_X, y: portalY }
      portalY += PORTAL_SPACING
    }
    positions[host] = byName
  }
  return positions
}

// EDGE GEOMETRY

export interface EdgeLine {
  readonly d: string
  readonly kind: 'Follow' | 'Outcome'
  readonly isFollowed: boolean
}

const rowCenterY = (node: LensNode, path: string): Option.Option<number> =>
  pipe(
    Array.findFirstIndex(
      node.rows,
      row => row._tag === 'EdgeRow' && row.path === path,
    ),
    Option.map(
      index =>
        CARD_HEADER_HEIGHT +
        ROWS_PADDING_TOP +
        index * ROW_HEIGHT +
        ROW_HEIGHT / 2,
    ),
  )

const cardHeight = (node: LensNode): number =>
  CARD_HEADER_HEIGHT +
  ROWS_PADDING_TOP +
  node.rows.length * ROW_HEIGHT +
  6 +
  (Record.size(node.params) > 0
    ? 13 + Record.size(node.params) * PARAM_ROW_HEIGHT
    : 0)

const curve = (x1: number, y1: number, x2: number, y2: number): string => {
  const bend = Math.max(40, Math.abs(x2 - x1) / 2) * (x1 < x2 ? 1 : -1)
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

export const edgeLines = (
  nodes: Nodes,
  selections: Selections,
  positions: Positions,
  host: string,
): ReadonlyArray<EdgeLine> => {
  const byName = positions[host] ?? {}
  const cards = cardNodes(nodes, host)
  const cardNames = Array.map(cards, node => node.name)
  const widthOf = (name: string) =>
    Array.contains(cardNames, name) ? CARD_WIDTH : PORTAL_WIDTH

  const followLines = Array.flatMap(cards, node =>
    Array.getSomes(
      Array.map(node.edges, edge =>
        Option.all({
          sourcePosition: Option.fromNullishOr(byName[node.name]),
          targetPosition: Option.fromNullishOr(byName[edge.target]),
          rowY: rowCenterY(node, edge.path),
        }).pipe(
          Option.map(({ sourcePosition, targetPosition, rowY }) => {
            const isFollowed = pipe(
              Option.fromNullishOr(selections[node.name]),
              Option.match({
                onNone: () => false,
                onSome: selection => Record.has(selection.follows, edge.path),
              }),
            )
            const x1 = sourcePosition.x + CARD_WIDTH
            const y1 = sourcePosition.y + rowY
            if (edge.target === node.name) {
              const selfLoop = `M ${x1} ${y1} C ${x1 + 55} ${y1 - 8}, ${x1 + 55} ${y1 - 60}, ${x1 - 8} ${sourcePosition.y + 6}`
              return { d: selfLoop, kind: 'Follow' as const, isFollowed }
            }
            const isTargetToTheRight = x1 < targetPosition.x
            const x2 = isTargetToTheRight
              ? targetPosition.x
              : targetPosition.x + widthOf(edge.target)
            return {
              d: curve(x1, y1, x2, targetPosition.y + 16),
              kind: 'Follow' as const,
              isFollowed,
            }
          }),
        ),
      ),
    ),
  )

  const outcomeLines = Array.flatMap(cards, node =>
    Array.getSomes(
      Array.map(node.outcomes, outcome =>
        Option.all({
          target: outcome.maybeTarget,
          sourcePosition: Option.fromNullishOr(byName[node.name]),
        }).pipe(
          Option.flatMap(({ target, sourcePosition }) =>
            Option.map(
              Option.fromNullishOr(byName[target]),
              targetPosition => ({
                d: curve(
                  sourcePosition.x + CARD_WIDTH,
                  sourcePosition.y + cardHeight(node) - 12,
                  targetPosition.x,
                  targetPosition.y + 16,
                ),
                kind: 'Outcome' as const,
                isFollowed: false,
              }),
            ),
          ),
        ),
      ),
    ),
  )

  return Array.appendAll(followLines, outcomeLines)
}
