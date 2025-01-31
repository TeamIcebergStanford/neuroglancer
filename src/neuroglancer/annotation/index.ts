/**
 * @license
 * Copyright 2018 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Basic annotation data structures.
 */

import {BoundingBox, CoordinateSpaceTransform, WatchableCoordinateSpaceTransform} from 'neuroglancer/coordinate_transform';
import {arraysEqual} from 'neuroglancer/util/array';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {Endianness, ENDIANNESS} from 'neuroglancer/util/endian';
import {expectArray, parseArray, parseFixedLengthArray, verifyEnumString, verifyFiniteFloat, verifyFiniteNonNegativeFloat, verifyObject, verifyObjectProperty, verifyOptionalString, verifyString} from 'neuroglancer/util/json';
import {getRandomHexString} from 'neuroglancer/util/random';
import {NullarySignal, Signal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';

export type AnnotationId = string;

export class AnnotationReference extends RefCounted {
  changed = new NullarySignal();

  /**
   * If `undefined`, we are still waiting to look up the result.  If `null`, annotation has been
   * deleted.
   */
  value: Annotation|null|undefined;

  constructor(public id: AnnotationId) {
    super();
  }
}

export enum AnnotationType {
  POINT,
  LINE,
  AXIS_ALIGNED_BOUNDING_BOX,
  ELLIPSOID,
}

export const annotationTypes = [
  AnnotationType.POINT,
  AnnotationType.LINE,
  AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
  AnnotationType.ELLIPSOID,
];

export interface AnnotationPropertySpecBase {
  identifier: string;
  description: string|undefined;
}

export interface AnnotationColorPropertySpec extends AnnotationPropertySpecBase {
  type: 'rgb'|'rgba';
  default: number;
}

export interface AnnotationNumericPropertySpec extends AnnotationPropertySpecBase {
  type: 'float32'|'uint32'|'int32'|'uint16'|'int16'|'uint8'|'int8';
  default: number;
  min?: number;
  max?: number;
  step?: number;
}

export type AnnotationPropertySpec = AnnotationColorPropertySpec|AnnotationNumericPropertySpec;

export interface AnnotationPropertyTypeHandler {
  serializedBytes(rank: number): number;
  alignment(rank: number): number;
  serializeCode(property: string, offset: string, rank: number): string;
  deserializeCode(property: string, offset: string, rank: number): string;
}

export const annotationPropertyTypeHandlers:
    {[K in AnnotationPropertySpec['type']]: AnnotationPropertyTypeHandler} = {
      'rgb': {
        serializedBytes() {
          return 3;
        },
        alignment() {
          return 1;
        },
        serializeCode(property: string, offset: string) {
          return `dv.setUint16(${offset}, ${property}, true);` +
              `dv.setUint8(${offset} + 2, ${property} >>> 16);`;
        },
        deserializeCode(property: string, offset: string) {
          return `${property} = dv.getUint16(${offset}, true) | (dv.getUint8(${
              offset} + 2) << 16);`;
        },
      },
      'rgba': {
        serializedBytes() {
          return 4;
        },
        alignment() {
          return 1;
        },
        serializeCode(property: string, offset: string) {
          return `dv.setUint32(${offset}, ${property}, true);`;
        },
        deserializeCode(property: string, offset: string) {
          return `${property} = dv.getUint32(${offset}, true);`;
        },
      },
      'float32': {
        serializedBytes() {
          return 4;
        },
        alignment() {
          return 4;
        },
        serializeCode(property: string, offset: string) {
          return `dv.setFloat32(${offset}, ${property}, isLittleEndian);`;
        },
        deserializeCode(property: string, offset: string) {
          return `${property} = dv.getFloat32(${offset}, isLittleEndian);`;
        }
      },
      'uint32': {
        serializedBytes() {
          return 4;
        },
        alignment() {
          return 4;
        },
        serializeCode(property: string, offset: string) {
          return `dv.setUint32(${offset}, ${property}, isLittleEndian);`;
        },
        deserializeCode(property: string, offset: string) {
          return `${property} = dv.getUint32(${offset}, isLittleEndian);`;
        }
      },
      'int32': {
        serializedBytes() {
          return 4;
        },
        alignment() {
          return 4;
        },
        serializeCode(property: string, offset: string) {
          return `dv.setInt32(${offset}, ${property}, isLittleEndian);`;
        },
        deserializeCode(property: string, offset: string) {
          return `${property} = dv.getInt32(${offset}, isLittleEndian);`;
        }
      },
      'uint16': {
        serializedBytes() {
          return 2;
        },
        alignment() {
          return 2;
        },
        serializeCode(property: string, offset: string) {
          return `dv.setUint16(${offset}, ${property}, isLittleEndian);`;
        },
        deserializeCode(property: string, offset: string) {
          return `${property} = dv.getUint16(${offset}, isLittleEndian);`;
        }
      },
      'int16': {
        serializedBytes() {
          return 2;
        },
        alignment() {
          return 2;
        },
        serializeCode(property: string, offset: string) {
          return `dv.setInt16(${offset}, ${property}, isLittleEndian);`;
        },
        deserializeCode(property: string, offset: string) {
          return `${property} = dv.getInt16(${offset}, isLittleEndian);`;
        }
      },
      'uint8': {
        serializedBytes() {
          return 1;
        },
        alignment() {
          return 1;
        },
        serializeCode(property: string, offset: string) {
          return `dv.setUint8(${offset}, ${property});`;
        },
        deserializeCode(property: string, offset: string) {
          return `${property} = dv.getUint8(${offset});`;
        }
      },
      'int8': {
        serializedBytes() {
          return 2;
        },
        alignment() {
          return 1;
        },
        serializeCode(property: string, offset: string) {
          return `dv.setInt8(${offset}, ${property});`;
        },
        deserializeCode(property: string, offset: string) {
          return `${property} = dv.getInt8(${offset});`;
        }
      },
    };

export function getPropertyOffsets(
    rank: number, propertySpecs: readonly Readonly<AnnotationPropertySpec>[]) {
  let serializedBytes = 0;
  const numProperties = propertySpecs.length;
  const permutation = new Array<number>(numProperties);
  for (let i = 0; i < numProperties; ++i) {
    permutation[i] = i;
  }
  const getAlignment = (i: number) =>
      annotationPropertyTypeHandlers[propertySpecs[i].type].alignment(rank);
  permutation.sort((i, j) => getAlignment(j) - getAlignment(i));
  const offsets = new Array<number>(numProperties);
  for (let outputIndex = 0; outputIndex < numProperties; ++outputIndex) {
    const propertyIndex = permutation[outputIndex];
    const spec = propertySpecs[propertyIndex];
    const handler = annotationPropertyTypeHandlers[spec.type];
    const numBytes = handler.serializedBytes(rank);
    const alignment = handler.alignment(rank);
    serializedBytes += (alignment - (serializedBytes % alignment)) % alignment;
    offsets[propertyIndex] = serializedBytes;
    serializedBytes += numBytes;
  }
  serializedBytes += (4 - (serializedBytes % 4)) % 4;
  return {serializedBytes, offsets};
}

export class AnnotationPropertySerializer {
  serializedBytes: number;
  serialize: (buffer: DataView, offset: number, isLittleEndian: boolean, properties: any[]) => void;
  deserialize:
      (buffer: DataView, offset: number, isLittleEndian: boolean, properties: any[]) => void;
  constructor(
      public rank: number, public propertySpecs: readonly Readonly<AnnotationPropertySpec>[]) {
    if (propertySpecs.length === 0) {
      this.serializedBytes = 0;
      this.serialize = this.deserialize = () => {};
      return;
    }
    let serializeCode = '';
    let deserializeCode = '';
    const {serializedBytes, offsets} = getPropertyOffsets(rank, propertySpecs);
    const numProperties = propertySpecs.length;
    for (let propertyIndex = 0; propertyIndex < numProperties; ++propertyIndex) {
      const spec = propertySpecs[propertyIndex];
      const handler = annotationPropertyTypeHandlers[spec.type];
      const propId = `properties[${propertyIndex}]`;
      const offsetExpr = `offset + ${offsets[propertyIndex]}`;
      serializeCode += handler.serializeCode(propId, offsetExpr, rank);
      deserializeCode += handler.deserializeCode(propId, offsetExpr, rank);
    }
    this.serializedBytes = serializedBytes;
    this.serialize =
        new Function('dv', 'offset', 'isLittleEndian', 'properties', serializeCode) as any;
    this.deserialize =
        new Function('dv', 'offset', 'isLittleEndian', 'properties', deserializeCode) as any;
  }
}

export interface AnnotationBase {
  /**
   * If equal to `undefined`, then the description is unknown (possibly still being loaded).  If
   * equal to `null`, then there is no description.
   */
  description?: string|undefined|null;

  id: AnnotationId;
  type: AnnotationType;

  relatedSegments?: Uint64[][];
  properties: any[];
}

export interface Line extends AnnotationBase {
  pointA: Float32Array;
  pointB: Float32Array;
  type: AnnotationType.LINE;
}

export interface Point extends AnnotationBase {
  point: Float32Array;
  type: AnnotationType.POINT;
}

export interface AxisAlignedBoundingBox extends AnnotationBase {
  pointA: Float32Array;
  pointB: Float32Array;
  type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;
}

export interface Ellipsoid extends AnnotationBase {
  center: Float32Array;
  radii: Float32Array;
  type: AnnotationType.ELLIPSOID;
}

export type Annotation = Line|Point|AxisAlignedBoundingBox|Ellipsoid;

export interface AnnotationTypeHandler<T extends Annotation> {
  icon: string;
  description: string;
  toJSON: (annotation: T, rank: number) => any;
  restoreState: (annotation: T, obj: any, rank: number) => void;
  serializedBytes: (rank: number) => number;
  serialize:
      (buffer: DataView, offset: number, isLittleEndian: boolean, rank: number,
       annotation: T) => void;
  deserialize:
      (buffer: DataView, offset: number, isLittleEndian: boolean, rank: number, id: string) => T;
}

const typeHandlers = new Map<AnnotationType, AnnotationTypeHandler<Annotation>>();
export function getAnnotationTypeHandler(type: AnnotationType) {
  return typeHandlers.get(type)!;
}

function serializeFloatVector(
    buffer: DataView, offset: number, isLittleEndian: boolean, rank: number, vec: Float32Array) {
  for (let i = 0; i < rank; ++i) {
    buffer.setFloat32(offset, vec[i], isLittleEndian);
    offset += 4;
  }
  return offset;
}

function serializeTwoFloatVectors(
    buffer: DataView, offset: number, isLittleEndian: boolean, rank: number, vecA: Float32Array,
    vecB: Float32Array) {
  offset = serializeFloatVector(buffer, offset, isLittleEndian, rank, vecA);
  offset = serializeFloatVector(buffer, offset, isLittleEndian, rank, vecB);
  return offset;
}

function deserializeFloatVector(
    buffer: DataView, offset: number, isLittleEndian: boolean, rank: number, vec: Float32Array) {
  for (let i = 0; i < rank; ++i) {
    vec[i] = buffer.getFloat32(offset, isLittleEndian);
    offset += 4;
  }
  return offset;
}

function deserializeTwoFloatVectors(
    buffer: DataView, offset: number, isLittleEndian: boolean, rank: number, vecA: Float32Array,
  vecB: Float32Array) {
  offset = deserializeFloatVector(buffer, offset, isLittleEndian, rank, vecA);
  offset = deserializeFloatVector(buffer, offset, isLittleEndian, rank, vecB);
  return offset;
}

typeHandlers.set(AnnotationType.LINE, {
  icon: 'ꕹ',
  description: 'Line',
  toJSON(annotation: Line) {
    return {
      pointA: Array.from(annotation.pointA),
      pointB: Array.from(annotation.pointB),
    };
  },
  restoreState(annotation: Line, obj: any, rank: number) {
    annotation.pointA = verifyObjectProperty(
        obj, 'pointA', x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteFloat));
    annotation.pointB = verifyObjectProperty(
        obj, 'pointB', x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteFloat));
  },
  serializedBytes(rank: number) {
    return 2 * 4 * rank;
  },
  serialize(buffer: DataView, offset: number, isLittleEndian: boolean, rank: number, annotation: Line) {
    serializeTwoFloatVectors(buffer, offset, isLittleEndian, rank, annotation.pointA, annotation.pointB);
  },
  deserialize:
      (buffer: DataView, offset: number, isLittleEndian: boolean, rank: number, id: string):
          Line => {
            const pointA = new Float32Array(rank);
            const pointB = new Float32Array(rank);
            deserializeTwoFloatVectors(buffer, offset, isLittleEndian, rank, pointA, pointB);
            return {type: AnnotationType.LINE, pointA, pointB, id, properties: []};
          },
});

typeHandlers.set(AnnotationType.POINT, {
  icon: '⚬',
  description: 'Point',
  toJSON: (annotation: Point) => {
    return {
      point: Array.from(annotation.point),
    };
  },
  restoreState: (annotation: Point, obj: any, rank: number) => {
    annotation.point = verifyObjectProperty(
        obj, 'point', x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteFloat));
  },
  serializedBytes: rank => rank * 4,
  serialize:
      (buffer: DataView, offset: number, isLittleEndian: boolean, rank: number,
       annotation: Point) => {
        serializeFloatVector(buffer, offset, isLittleEndian, rank, annotation.point);
      },
  deserialize:
      (buffer: DataView, offset: number, isLittleEndian: boolean, rank: number, id: string):
          Point => {
            const point = new Float32Array(rank);
            deserializeFloatVector(buffer, offset, isLittleEndian, rank, point);
            return {type: AnnotationType.POINT, point, id, properties: []};
          },
});

typeHandlers.set(AnnotationType.AXIS_ALIGNED_BOUNDING_BOX, {
  icon: '❑',
  description: 'Bounding Box',
  toJSON: (annotation: AxisAlignedBoundingBox) => {
    return {
      pointA: Array.from(annotation.pointA),
      pointB: Array.from(annotation.pointB),
    };
  },
  restoreState: (annotation: AxisAlignedBoundingBox, obj: any, rank: number) => {
    annotation.pointA = verifyObjectProperty(
        obj, 'pointA', x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteFloat));
    annotation.pointB = verifyObjectProperty(
        obj, 'pointB', x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteFloat));
  },
  serializedBytes: rank => 2 * 4 * rank,
  serialize(buffer: DataView, offset: number, isLittleEndian: boolean, rank: number, annotation: AxisAlignedBoundingBox) {
    serializeTwoFloatVectors(buffer, offset, isLittleEndian, rank, annotation.pointA, annotation.pointB);
  },
  deserialize: (
      buffer: DataView, offset: number, isLittleEndian: boolean, rank: number, id: string):
      AxisAlignedBoundingBox => {
        const pointA = new Float32Array(rank);
        const pointB = new Float32Array(rank);
        deserializeTwoFloatVectors(buffer, offset, isLittleEndian, rank, pointA, pointB);
        return {type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX, pointA, pointB, id, properties: []};
      },
});

typeHandlers.set(AnnotationType.ELLIPSOID, {
  icon: '◎',
  description: 'Ellipsoid',
  toJSON: (annotation: Ellipsoid) => {
    return {
      center: Array.from(annotation.center),
      radii: Array.from(annotation.radii),
    };
  },
  restoreState: (annotation: Ellipsoid, obj: any, rank: number) => {
    annotation.center = verifyObjectProperty(
        obj, 'center', x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteFloat));
    annotation.radii = verifyObjectProperty(
        obj, 'radii',
        x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteNonNegativeFloat));
  },
  serializedBytes: rank => 2 * 4 * rank,
  serialize(
      buffer: DataView, offset: number, isLittleEndian: boolean, rank: number,
      annotation: Ellipsoid) {
    serializeTwoFloatVectors(
        buffer, offset, isLittleEndian, rank, annotation.center, annotation.radii);
  },
  deserialize:
      (buffer: DataView, offset: number, isLittleEndian: boolean, rank: number, id: string):
          Ellipsoid => {
            const center = new Float32Array(rank);
            const radii = new Float32Array(rank);
            deserializeTwoFloatVectors(buffer, offset, isLittleEndian, rank, center, radii);
            return {type: AnnotationType.ELLIPSOID, center, radii, id, properties: []};
          },
});

export interface AnnotationSchema {
  rank: number;
  relationships: readonly string[];
  properties: readonly AnnotationPropertySpec[];
}

function annotationToJson(annotation: Annotation, schema: AnnotationSchema) {
  const result = getAnnotationTypeHandler(annotation.type).toJSON(annotation, schema.rank);
  result.type = AnnotationType[annotation.type].toLowerCase();
  result.id = annotation.id;
  result.description = annotation.description || undefined;
  const {relatedSegments} = annotation;
  if (relatedSegments !== undefined && relatedSegments.some(x => x.length !== 0)) {
    result.segments = relatedSegments.map(segments => segments.map(x => x.toString()));
  }
  if (schema.properties.length !== 0) {
    result.props = annotation.properties.slice();
  }
  return result;
}

function restoreAnnotation(obj: any, schema: AnnotationSchema, allowMissingId = false): Annotation {
  verifyObject(obj);
  const type = verifyObjectProperty(obj, 'type', x => verifyEnumString(x, AnnotationType));
  const id =
      verifyObjectProperty(obj, 'id', allowMissingId ? verifyOptionalString : verifyString) ||
      makeAnnotationId();
  const relatedSegments = verifyObjectProperty(obj, 'segments', relObj => {
    if (relObj === undefined) {
      return schema.relationships.map(() => []);
    }
    const a = expectArray(relObj);
    if (a.length === 0) {
      return schema.relationships.map(() => []);
    }
    if (schema.relationships.length === 1 && !Array.isArray(a[0])) {
      return [parseArray(a, x => Uint64.parseString(x))];
    }
    return parseArray(
        expectArray(relObj, schema.relationships.length),
        segments => parseArray(segments, y => Uint64.parseString(y)));
  });
  const properties = verifyObjectProperty(obj, 'props', propsObj => {
    if (propsObj === undefined) return schema.properties.map(x => x.default);
    return parseArray(expectArray(propsObj, schema.properties.length), x => Number(x));
  });
  const result: Annotation = {
    id,
    description: verifyObjectProperty(obj, 'description', verifyOptionalString),
    relatedSegments,
    properties,
    type,
  } as Annotation;
  getAnnotationTypeHandler(type).restoreState(result, obj, schema.rank);
  return result;
}

export interface AnnotationSourceSignals {
  changed: NullarySignal;
  childAdded: Signal<(annotation: Annotation) => void>;
  childUpdated: Signal<(annotation: Annotation) => void>;
  childDeleted: Signal<(annotationId: string) => void>;
}

export class AnnotationSource extends RefCounted implements AnnotationSourceSignals {
  protected annotationMap = new Map<AnnotationId, Annotation>();
  changed = new NullarySignal();
  readonly = false;
  childAdded = new Signal<(annotation: Annotation) => void>();
  childUpdated = new Signal<(annotation: Annotation) => void>();
  childDeleted = new Signal<(annotationId: string) => void>();

  private pending = new Set<AnnotationId>();

  protected rank_: number;

  get rank() {
    return this.rank_;
  }

  readonly annotationPropertySerializer: AnnotationPropertySerializer;

  constructor(
      rank: number, public readonly relationships: readonly string[] = [],
      public readonly properties: Readonly<AnnotationPropertySpec>[] = []) {
    super();
    this.rank_ = rank;
    this.annotationPropertySerializer = new AnnotationPropertySerializer(rank, properties);
  }

  add(annotation: Annotation, commit: boolean = true): AnnotationReference {
    this.ensureUpdated();
    if (!annotation.id) {
      annotation.id = makeAnnotationId();
    } else if (this.annotationMap.has(annotation.id)) {
      throw new Error(`Annotation id already exists: ${JSON.stringify(annotation.id)}.`);
    }
    this.annotationMap.set(annotation.id, annotation);
    this.changed.dispatch();
    this.childAdded.dispatch(annotation);
    if (!commit) {
      this.pending.add(annotation.id);
    }
    return this.getReference(annotation.id);
  }

  commit(reference: AnnotationReference): void {
    this.ensureUpdated();
    const id = reference.id;
    this.pending.delete(id);
  }

  update(reference: AnnotationReference, annotation: Annotation) {
    this.ensureUpdated();
    if (reference.value === null) {
      throw new Error(`Annotation already deleted.`);
    }
    reference.value = annotation;
    this.annotationMap.set(annotation.id, annotation);
    reference.changed.dispatch();
    this.changed.dispatch();
    this.childUpdated.dispatch(annotation);
  }

  [Symbol.iterator]() {
    this.ensureUpdated();
    return this.annotationMap.values();
  }

  get(id: AnnotationId) {
    this.ensureUpdated();
    return this.annotationMap.get(id);
  }

  delete(reference: AnnotationReference) {
    if (reference.value === null) {
      return;
    }
    reference.value = null;
    this.annotationMap.delete(reference.id);
    this.pending.delete(reference.id);
    reference.changed.dispatch();
    this.changed.dispatch();
    this.childDeleted.dispatch(reference.id);
  }

  getReference(id: AnnotationId): AnnotationReference {
    let existing = this.references.get(id);
    if (existing !== undefined) {
      return existing.addRef();
    }
    existing = new AnnotationReference(id);
    existing.value = this.annotationMap.get(id) || null;
    this.references.set(id, existing);
    existing.registerDisposer(() => {
      this.references.delete(id);
    });
    return existing;
  }

  references = new Map<AnnotationId, Borrowed<AnnotationReference>>();

  protected ensureUpdated() {}

  toJSON() {
    this.ensureUpdated();
    const result: any[] = [];
    const {pending} = this;
    for (const annotation of this) {
      if (pending.has(annotation.id)) {
        // Don't serialize uncommitted annotations.
        continue;
      }
      result.push(annotationToJson(annotation, this));
    }
    return result;
  }

  clear() {
    this.annotationMap.clear();
    this.pending.clear();
    this.changed.dispatch();
  }

  restoreState(obj: any) {
    this.ensureUpdated();
    const {annotationMap} = this;
    annotationMap.clear();
    this.pending.clear();
    if (obj !== undefined) {
      parseArray(obj, x => {
        const annotation = restoreAnnotation(x, this);
        annotationMap.set(annotation.id, annotation);
      });
    }
    for (const reference of this.references.values()) {
      const {id} = reference;
      const value = annotationMap.get(id);
      reference.value = value || null;
      reference.changed.dispatch();
    }
    this.changed.dispatch();
  }

  reset() {
    this.clear();
  }
}

export class LocalAnnotationSource extends AnnotationSource {
  private curCoordinateTransform: CoordinateSpaceTransform;

  get rank() {
    this.ensureUpdated();
    return this.rank_;
  }

  constructor(public watchableTransform: WatchableCoordinateSpaceTransform) {
    super(watchableTransform.value.sourceRank, ['segments']);
    this.curCoordinateTransform = watchableTransform.value;
    this.registerDisposer(watchableTransform.changed.add(() => this.ensureUpdated()));
  }

  ensureUpdated() {
    const transform = this.watchableTransform.value;
    const {curCoordinateTransform} = this;
    if (transform === curCoordinateTransform) return;
    this.curCoordinateTransform = transform;
    const sourceRank = transform.sourceRank;
    const oldSourceRank = curCoordinateTransform.sourceRank;
    if (oldSourceRank === sourceRank &&
        ((curCoordinateTransform.inputSpace === transform.inputSpace) ||
         arraysEqual(
             curCoordinateTransform.inputSpace.ids.slice(0, sourceRank),
             transform.inputSpace.ids.slice(0, sourceRank)))) {
      return;
    }
    const {ids: newIds} = transform.inputSpace;
    const oldIds = curCoordinateTransform.inputSpace.ids;
    const newToOldDims: number[] = [];
    for (let newDim = 0; newDim < sourceRank; ++newDim) {
      let oldDim = oldIds.indexOf(newIds[newDim]);
      if (oldDim >= oldSourceRank) {
        oldDim = -1;
      }
      newToOldDims.push(oldDim);
    }
    const mapVector = (radii: Float32Array) => {
      const newRadii = new Float32Array(sourceRank);
      for (let i = 0; i < sourceRank; ++i) {
        const oldDim = newToOldDims[i];
        newRadii[i] = (oldDim === -1) ? 0 : radii[i];
      }
      return newRadii;
    };

    for (const annotation of this.annotationMap.values()) {
      switch (annotation.type) {
        case AnnotationType.POINT:
          annotation.point = mapVector(annotation.point);
          break;
        case AnnotationType.LINE:
        case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
          annotation.pointA = mapVector(annotation.pointA);
          annotation.pointB = mapVector(annotation.pointB);
          break;
        case AnnotationType.ELLIPSOID:
          annotation.center = mapVector(annotation.center);
          annotation.radii = mapVector(annotation.radii);
          break;
      }
    }
    this.rank_ = sourceRank;
    this.changed.dispatch();
  }
}

export const DATA_BOUNDS_DESCRIPTION = 'Data Bounds';

export function makeAnnotationId() {
  return getRandomHexString(160);
}

export function makeDataBoundsBoundingBoxAnnotation(box: BoundingBox): AxisAlignedBoundingBox {
  return {
    type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
    id: 'data-bounds',
    description: DATA_BOUNDS_DESCRIPTION,
    pointA: new Float32Array(box.lowerBounds),
    pointB: new Float32Array(box.upperBounds),
    properties: [],
  };
}

export function makeDataBoundsBoundingBoxAnnotationSet(box: BoundingBox): AnnotationSource {
  const annotationSource = new AnnotationSource(box.lowerBounds.length);
  annotationSource.readonly = true;
  annotationSource.add(makeDataBoundsBoundingBoxAnnotation(box));
  return annotationSource;
}

export interface SerializedAnnotations {
  data: Uint8Array;
  typeToIds: string[][];
  typeToOffset: number[];
  typeToIdMaps: Map<string, number>[];
}

function serializeAnnotations(
    allAnnotations: Annotation[][],
    propertySerializer: AnnotationPropertySerializer): SerializedAnnotations {
  const {rank} = propertySerializer;
  let totalBytes = 0;
  const typeToOffset: number[] = [];
  const serializedPropertiesBytes = propertySerializer.serializedBytes;
  for (const annotationType of annotationTypes) {
    typeToOffset[annotationType] = totalBytes;
    const annotations: Annotation[] = allAnnotations[annotationType];
    const count = annotations.length;
    const handler = getAnnotationTypeHandler(annotationType);
    totalBytes += (handler.serializedBytes(rank) + serializedPropertiesBytes) * count;
    totalBytes += (4 - (totalBytes % 4)) % 4;
  }
  const serializeProperties = propertySerializer.serialize;
  const typeToIds: string[][] = [];
  const typeToIdMaps: Map<string, number>[] = [];
  const data = new ArrayBuffer(totalBytes);
  const dataView = new DataView(data);
  const isLittleEndian = ENDIANNESS === Endianness.LITTLE;
  for (const annotationType of annotationTypes) {
    const annotations: Annotation[] = allAnnotations[annotationType];
    typeToIds[annotationType] = annotations.map(x => x.id);
    typeToIdMaps[annotationType] = new Map(annotations.map((x, i) => [x.id, i]));
    const handler = getAnnotationTypeHandler(annotationType);
    const serialize = handler.serialize;
    const geometryBytes = handler.serializedBytes(rank);
    let offset = typeToOffset[annotationType];
    for (const annotation of annotations) {
      serialize(dataView, offset, isLittleEndian, rank, annotation);
      offset += geometryBytes;
      serializeProperties(dataView, offset, isLittleEndian, annotation.properties);
      offset += serializedPropertiesBytes;
    }
  }
  return {data: new Uint8Array(data), typeToIds, typeToOffset, typeToIdMaps};
}

export class AnnotationSerializer {
  annotations: [Point[], Line[], AxisAlignedBoundingBox[], Ellipsoid[]] = [[], [], [], []];
  constructor(public propertySerializer: AnnotationPropertySerializer) {}
  add(annotation: Annotation) {
    (<Annotation[]>this.annotations[annotation.type]).push(annotation);
  }
  serialize(): SerializedAnnotations {
    return serializeAnnotations(this.annotations, this.propertySerializer);
  }
}

export function fixAnnotationAfterStructuredCloning(obj: Annotation|null) {
  if (obj == null) {
    return obj;
  }
  const {relatedSegments} = obj;
  if (relatedSegments !== undefined) {
    for (let i = 0, numRelationships = relatedSegments.length; i < numRelationships; ++i) {
      const segments = relatedSegments[i];
      if (segments === undefined) continue;
      relatedSegments[i] =
          segments.map((x: {low: number, high: number}) => new Uint64(x.low, x.high));
    }
  }
  return obj;
}
