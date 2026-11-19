import {
  CapsuleGeometry as ThreeCapsule,
  ConeGeometry as ThreeCone,
  CylinderGeometry as ThreeCylinder,
  SphereGeometry as ThreeSphere,
  TorusGeometry as ThreeTorus,
} from 'three'

// How finely the detailed models are cut: the round shapes below have about one edge for every `edge` units round them (the figure
// is 1.78 high), and never more than they are built with. In a game a champion is small on screen, so a ring on a finger or a rivet is
// a few sides and a head or a robe is as round as ever; champion select, where a champion fills the stage, cuts them finer
// (`cutFinely`). Fewer sides is fewer triangles drawn for each champion, for its shadow and for its outline.
const GAME_EDGE = 0.045
const FINE_EDGE = 0.008
let edge = GAME_EDGE

// Builds what `build` makes with the shapes cut finely, for a champion seen up close.
export function cutFinely<T>(build: () => T): T {
  const was = edge
  edge = FINE_EDGE
  try {
    return build()
  } finally {
    edge = was
  }
}

// The sides round a circle of radius `r`: as many as `most` at most, as few as `least` at least.
export function sidesFor(r: number, most: number, least = 5): number {
  return Math.max(Math.min(least, most), Math.min(most, Math.ceil((Math.PI * 2 * Math.abs(r)) / edge)))
}

// Along a length: as many segments as `most` at most, and `least` at least.
export function stepsFor(length: number, most: number, least = 2): number {
  return Math.max(Math.min(least, most), Math.min(most, Math.ceil(Math.abs(length) / edge)))
}

// three.js's own round shapes, taking the same arguments, with as many sides as their size wants (see above).
export class SphereGeometry extends ThreeSphere {
  constructor(radius = 1, widthSegments = 32, heightSegments = 16, phiStart?: number, phiLength?: number, thetaStart?: number, thetaLength?: number) {
    super(radius, sidesFor(radius, widthSegments, 6), sidesFor(radius / 2, heightSegments, 4), phiStart, phiLength, thetaStart, thetaLength)
  }
}

export class TorusGeometry extends ThreeTorus {
  constructor(radius = 1, tube = 0.4, radialSegments = 12, tubularSegments = 48, arc?: number) {
    super(radius, tube, sidesFor(tube, radialSegments, 3), sidesFor(radius * ((arc ?? Math.PI * 2) / (Math.PI * 2)), tubularSegments, 4), arc)
  }
}

export class CapsuleGeometry extends ThreeCapsule {
  constructor(radius = 1, length = 1, capSegments = 4, radialSegments = 8) {
    super(radius, length, sidesFor(radius / 2, capSegments, 2), sidesFor(radius, radialSegments, 5))
  }
}

export class CylinderGeometry extends ThreeCylinder {
  constructor(radiusTop = 1, radiusBottom = 1, height = 1, radialSegments = 32, heightSegments = 1, openEnded?: boolean, thetaStart?: number, thetaLength?: number) {
    super(radiusTop, radiusBottom, height, sidesFor(Math.max(radiusTop, radiusBottom), radialSegments, 8), heightSegments, openEnded, thetaStart, thetaLength)
  }
}

export class ConeGeometry extends ThreeCone {
  constructor(radius = 1, height = 1, radialSegments = 32, heightSegments = 1, openEnded?: boolean, thetaStart?: number, thetaLength?: number) {
    super(radius, height, sidesFor(radius, radialSegments, 8), heightSegments, openEnded, thetaStart, thetaLength)
  }
}
