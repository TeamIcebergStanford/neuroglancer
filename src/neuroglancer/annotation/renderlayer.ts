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

import 'neuroglancer/annotation/bounding_box';
import 'neuroglancer/annotation/line';
import 'neuroglancer/annotation/point';
import 'neuroglancer/annotation/ellipsoid';

import {AnnotationBase, AnnotationSerializer, AnnotationSource, annotationTypes, getAnnotationTypeHandler, SerializedAnnotations} from 'neuroglancer/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/annotation_layer_state';
import {ANNOTATION_PERSPECTIVE_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, ANNOTATION_RENDER_LAYER_RPC_ID, ANNOTATION_RENDER_LAYER_UPDATE_SEGMENTATION_RPC_ID, ANNOTATION_SPATIALLY_INDEXED_RENDER_LAYER_RPC_ID, forEachVisibleAnnotationChunk} from 'neuroglancer/annotation/base';
import {AnnotationGeometryChunkSource, AnnotationGeometryData, computeNumPickIds, MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {AnnotationRenderContext, AnnotationRenderHelper, getAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {LayerView, MouseSelectionState, VisibleLayerInfo} from 'neuroglancer/layer';
import {DisplayDimensionRenderInfo} from 'neuroglancer/navigation_state';
import {PerspectivePanel} from 'neuroglancer/perspective_view/panel';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {ChunkDisplayTransformParameters, ChunkTransformParameters, getChunkDisplayTransformParameters, getChunkPositionFromCombinedGlobalLocalPositions, getLayerDisplayDimensionMapping, RenderLayerTransformOrError} from 'neuroglancer/render_coordinate_transform';
import {RenderScaleHistogram} from 'neuroglancer/render_scale_statistics';
import {ThreeDimensionalRenderContext, VisibilityTrackedRenderLayer} from 'neuroglancer/renderlayer';
import {forEachVisibleSegment, getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {FrontendTransformedSource, getVolumetricTransformedSources, serializeAllTransformedSources} from 'neuroglancer/sliceview/frontend';
import {SliceViewPanelRenderContext, SliceViewPanelRenderLayer, SliceViewRenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {makeCachedDerivedWatchableValue, NestedStateManager, registerNested, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {arraysEqual} from 'neuroglancer/util/array';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {ValueOrError} from 'neuroglancer/util/error';
import {mat4} from 'neuroglancer/util/geom';
import {MessageList, MessageSeverity} from 'neuroglancer/util/message_list';
import {AnyConstructor, MixinConstructor} from 'neuroglancer/util/mixin';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {withSharedVisibility} from 'neuroglancer/visibility_priority/frontend';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {registerSharedObjectOwner, SharedObject} from 'neuroglancer/worker_rpc';

const tempMat = mat4.create();

function segmentationFilter(
    segmentationStates: readonly(SegmentationDisplayState | undefined | null)[]|undefined) {
  if (segmentationStates === undefined) return undefined;
  return (annotation: AnnotationBase) => {
    const {relatedSegments: relatedSegments} = annotation;
    if (relatedSegments === undefined) {
      return false;
    }
    for (let i = 0, count = relatedSegments.length; i < count; ++i) {
      const segmentationState = segmentationStates[i];
      if (segmentationState == null) continue;
      const {visibleSegments, segmentEquivalences} = segmentationState;
      for (const segment of relatedSegments[i]) {
        if (visibleSegments.has(segmentEquivalences.get(segment))) {
          return true;
        }
      }
    }
    return false;
  };
}

function serializeAnnotationSet(
    annotationSet: AnnotationSource, filter?: (annotation: AnnotationBase) => boolean) {
  const serializer = new AnnotationSerializer(annotationSet.annotationPropertySerializer);
  for (const annotation of annotationSet) {
    if (filter === undefined || filter(annotation)) {
      serializer.add(annotation);
    }
  }
  return serializer.serialize();
}

@registerSharedObjectOwner(ANNOTATION_RENDER_LAYER_RPC_ID)
class AnnotationLayerSharedObject extends withSharedVisibility
(SharedObject) {
  constructor(
      public chunkManager: Borrowed<ChunkManager>,
      public source: Borrowed<MultiscaleAnnotationSource>,
      public segmentationStates:
          WatchableValueInterface<(SegmentationDisplayState | undefined | null)[]|undefined>) {
    super();

    this.initializeCounterpart(this.chunkManager.rpc!, {
      chunkManager: this.chunkManager.rpcId,
      source: source.rpcId,
      segmentationStates: this.serializeDisplayState(),
    });

    const update = () => {
      const msg: any = {id: this.rpcId, segmentationStates: this.serializeDisplayState()};
      this.rpc!.invoke(ANNOTATION_RENDER_LAYER_UPDATE_SEGMENTATION_RPC_ID, msg);
    };
    this.registerDisposer(segmentationStates.changed.add(update));
  }

  private serializeDisplayState() {
    const {value: segmentationStates} = this.segmentationStates;
    if (segmentationStates === undefined) return undefined;
    return segmentationStates.map(segmentationState => {
      if (segmentationState == null) return segmentationState;
      return {
        segmentEquivalences: segmentationState.segmentEquivalences.rpcId,
        visibleSegments: segmentationState.visibleSegments.rpcId
      };
    });
  }
}

export class AnnotationLayer extends RefCounted {
  /**
   * Stores a serialized representation of the information needed to render the annotations.
   */
  buffer: Buffer|undefined;

  numPickIds: number = 0;

  /**
   * The value of this.state.annotationSet.changed.count when `buffer` was last updated.
   */
  private generation = -1;

  redrawNeeded = new NullarySignal();
  serializedAnnotations: SerializedAnnotations|undefined = undefined;

  get source() {
    return this.state.source;
  }
  get transform() {
    return this.state.transform;
  }
  get hoverState() {
    return this.state.displayState.hoverState;
  }

  private handleChangeAffectingBuffer = (() => {
    this.generation = -1;
    this.redrawNeeded.dispatch();
  });

  sharedObject: AnnotationLayerSharedObject|undefined;

  get visibility() {
    const {sharedObject} = this;
    if (sharedObject === undefined) {
      return undefined;
    }
    return sharedObject.visibility;
  }

  segmentationStates = this.registerDisposer(makeCachedDerivedWatchableValue(
      (_) => {
        const {displayState, source} = this.state;
        const {relationshipStates} = displayState;
        return displayState.displayUnfiltered.value ?
            undefined :
            source.relationships.map(relationship => {
              const state = relationshipStates.get(relationship);
              return state.showMatches.value ? state.segmentationState : undefined;
            });
      },
      [this.state.displayState.relationshipStates],
      (a, b) => {
        if (a === undefined || b === undefined) {
          return a === b;
        }
        return arraysEqual(a, b);
      }));

  constructor(public chunkManager: ChunkManager, public state: Owned<AnnotationLayerState>) {
    super();
    this.registerDisposer(state);
    this.registerDisposer(this.source.changed.add(this.handleChangeAffectingBuffer));
    this.registerDisposer(registerNested((context, segmentationStates) => {
      this.handleChangeAffectingBuffer();
      if (segmentationStates === undefined) return;
      for (const segmentationState of segmentationStates) {
        if (segmentationState == null) continue;
        context.registerDisposer(segmentationState.visibleSegments.changed.add(
            () => this.handleChangeAffectingBuffer()));
        context.registerDisposer(segmentationState.segmentEquivalences.changed.add(
            () => this.handleChangeAffectingBuffer()));
      }
    }, this.segmentationStates));
    if (!(this.source instanceof AnnotationSource)) {
      this.sharedObject = this.registerDisposer(
          new AnnotationLayerSharedObject(chunkManager, this.source, this.segmentationStates));
    }
    const {displayState} = this.state;
    this.registerDisposer(displayState.color.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(displayState.shader.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(displayState.shaderControls.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(this.hoverState.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(this.transform.changed.add(this.redrawNeeded.dispatch));
  }

  get gl() {
    return this.chunkManager.gl;
  }

  updateBuffer() {
    const {source} = this;
    if (source instanceof AnnotationSource) {
      const generation = source.changed.count;
      if (this.generation !== generation) {
        let {buffer} = this;
        if (buffer === undefined) {
          buffer = this.buffer = this.registerDisposer(new Buffer(this.chunkManager.gl));
        }
        this.generation = generation;
        const serializedAnnotations = this.serializedAnnotations =
            serializeAnnotationSet(source, segmentationFilter(this.segmentationStates.value));
        buffer.setData(this.serializedAnnotations.data);
        this.numPickIds = computeNumPickIds(serializedAnnotations);
      }
    }
  }
}

class AnnotationPerspectiveRenderLayerBase extends PerspectiveViewRenderLayer {
  constructor(public base: Owned<AnnotationLayer>) {
    super();
  }
}

class AnnotationSliceViewRenderLayerBase extends SliceViewPanelRenderLayer {
  constructor(public base: Owned<AnnotationLayer>) {
    super();
  }
}

interface AnnotationGeometryDataInterface {
  serializedAnnotations: SerializedAnnotations;
  buffer: Buffer;
  numPickIds: number;
}

interface AnnotationChunkRenderParameters {
  chunkTransform: ChunkTransformParameters;
  chunkDisplayTransform: ChunkDisplayTransformParameters;
  renderSubspaceTransform: Float32Array;
  modelClipBounds: Float32Array;
}

interface AttachmentState {
  chunkTransform: ValueOrError<ChunkTransformParameters>;
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  chunkRenderParameters: AnnotationChunkRenderParameters|undefined;
}

interface TransformedAnnotationSource extends
    FrontendTransformedSource<SliceViewRenderLayer, AnnotationGeometryChunkSource> {}

interface SpatiallyIndexedValidAttachmentState extends AttachmentState {
  sources?: NestedStateManager<TransformedAnnotationSource[][]>;
}

function getAnnotationProjectionParameters(chunkDisplayTransform: ChunkDisplayTransformParameters) {
  const {chunkTransform} = chunkDisplayTransform;
  const {unpaddedRank} = chunkTransform.modelTransform;
  const modelClipBounds = new Float32Array(unpaddedRank * 2);
  const renderSubspaceTransform = new Float32Array(unpaddedRank * 3);
  renderSubspaceTransform.fill(0);
  modelClipBounds.fill(1, unpaddedRank);
  const {numChunkDisplayDims, chunkDisplayDimensionIndices} = chunkDisplayTransform;
  for (let i = 0; i < numChunkDisplayDims; ++i) {
    const chunkDim = chunkDisplayDimensionIndices[i];
    modelClipBounds[unpaddedRank + chunkDim] = 0;
    renderSubspaceTransform[chunkDim * 3 + i] = 1;
  }
  return {modelClipBounds, renderSubspaceTransform};
}

function getChunkRenderParameters(
    chunkTransform: ValueOrError<ChunkTransformParameters>,
    displayDimensionRenderInfo: DisplayDimensionRenderInfo,
    messages: MessageList): AnnotationChunkRenderParameters|undefined {
  messages.clearMessages();
  const returnError = (message: string) => {
    messages.addMessage({severity: MessageSeverity.error, message});
    return undefined;
  };
  if (chunkTransform.error !== undefined) {
    return returnError(chunkTransform.error);
  }
  const layerRenderDimensionMapping = getLayerDisplayDimensionMapping(
      chunkTransform.modelTransform, displayDimensionRenderInfo.displayDimensionIndices);
  let chunkDisplayTransform: ChunkDisplayTransformParameters;
  try {
    chunkDisplayTransform =
        getChunkDisplayTransformParameters(chunkTransform, layerRenderDimensionMapping);
  } catch (e) {
    return returnError((e as Error).message);
  }
  const {modelClipBounds, renderSubspaceTransform} =
      getAnnotationProjectionParameters(chunkDisplayTransform);
  return {chunkTransform, chunkDisplayTransform, modelClipBounds, renderSubspaceTransform};
}


function AnnotationRenderLayer<TBase extends {
  new (...args: any[]): VisibilityTrackedRenderLayer &
  {
    base: AnnotationLayer
  }
}>(Base: TBase, renderHelperType: 'sliceViewRenderHelper'|'perspectiveViewRenderHelper') {
  class C extends Base {
    base: AnnotationLayer;
    curRank: number = -1;
    private renderHelpers: AnnotationRenderHelper[] = [];
    private tempChunkPosition: Float32Array;

    handleRankChanged() {
      const {rank} = this.base.source;
      if (rank === this.curRank) return;
      this.curRank = rank;
      this.tempChunkPosition = new Float32Array(rank);
      const {renderHelpers, gl} = this;
      for (const oldHelper of renderHelpers) {
        oldHelper.dispose();
      }
      const {properties} = this.base.source;
      const {displayState} = this.base.state;
      for (const annotationType of annotationTypes) {
        const handler = getAnnotationTypeRenderHandler(annotationType);
        const renderHelperConstructor = handler[renderHelperType];
        const helper = renderHelpers[annotationType] = new renderHelperConstructor(
            gl, annotationType, rank, properties, displayState.shaderControls,
            displayState.fallbackShaderControls, displayState.shaderError);
        helper.pickIdsPerInstance = handler.pickIdsPerInstance;
        helper.targetIsSliceView = renderHelperType === 'sliceViewRenderHelper';
      }
    }

    constructor(...args: any[]) {
      super(...args);
      const base = this.registerDisposer(this.base);
      const baseVisibility = base.visibility;
      if (baseVisibility !== undefined) {
        this.registerDisposer(baseVisibility.add(this.visibility));
      }
      this.registerDisposer(() => {
        for (const helper of this.renderHelpers) {
          helper.dispose();
        }
      });
      this.role = base.state.role;
      this.registerDisposer(base.redrawNeeded.add(this.redrawNeeded.dispatch));
      this.handleRankChanged();
    }

    attach(attachment: VisibleLayerInfo<LayerView, AttachmentState>) {
      super.attach(attachment);
      this.handleRankChanged();
      const {chunkTransform} = this;
      const displayDimensionRenderInfo = attachment.view.displayDimensionRenderInfo.value;
      attachment.state = {
        chunkTransform,
        displayDimensionRenderInfo,
        chunkRenderParameters: getChunkRenderParameters(
            chunkTransform, displayDimensionRenderInfo, attachment.messages),
      };
    }

    updateAttachmentState(attachment: VisibleLayerInfo<LayerView, AttachmentState>):
        AnnotationChunkRenderParameters|undefined {
      const state = attachment.state!;
      this.handleRankChanged();
      const {chunkTransform} = this;
      const displayDimensionRenderInfo = attachment.view.displayDimensionRenderInfo.value;
      if (state !== undefined && state.chunkTransform === chunkTransform &&
          state.displayDimensionRenderInfo === displayDimensionRenderInfo) {
        return state.chunkRenderParameters;
      }
      state.chunkTransform = chunkTransform;
      state.displayDimensionRenderInfo = displayDimensionRenderInfo;
      const chunkRenderParameters = state.chunkRenderParameters =
          getChunkRenderParameters(chunkTransform, displayDimensionRenderInfo, attachment.messages);
      return chunkRenderParameters;
    }

    get chunkTransform() {
      return this.base.state.chunkTransform.value;
    }

    updateModelClipBounds(
        renderContext: ThreeDimensionalRenderContext, state: AnnotationChunkRenderParameters) {
      const {modelClipBounds} = state;
      const rank = this.curRank;
      const {chunkTransform} = state;
      getChunkPositionFromCombinedGlobalLocalPositions(
          modelClipBounds.subarray(0, rank), renderContext.projectionParameters.globalPosition,
          this.base.state.localPosition.value, chunkTransform.layerRank,
          chunkTransform.combinedGlobalLocalToChunkTransform);
    }

    get gl() {
      return this.base.chunkManager.gl;
    }

    drawGeometryChunkData(
        chunk: AnnotationGeometryData,
        renderContext: PerspectiveViewRenderContext|SliceViewPanelRenderContext,
        state: AnnotationChunkRenderParameters, maxCount: number = Number.POSITIVE_INFINITY) {
      if (!chunk.bufferValid) {
        let {buffer} = chunk;
        if (buffer === undefined) {
          buffer = chunk.buffer = new Buffer(this.gl);
        }
        const {serializedAnnotations} = chunk;
        buffer.setData(serializedAnnotations.data);
        chunk.numPickIds = computeNumPickIds(serializedAnnotations);
        chunk.bufferValid = true;
      }
      this.drawGeometry(chunk as AnnotationGeometryDataInterface, renderContext, state, maxCount);
    }

    drawGeometry(
        chunk: AnnotationGeometryDataInterface,
        renderContext: PerspectiveViewRenderContext|SliceViewPanelRenderContext,
        state: AnnotationChunkRenderParameters, maxCount: number = Number.POSITIVE_INFINITY) {
      const {base} = this;
      const {chunkDisplayTransform} = state;
      const {serializedAnnotations} = chunk;
      const {typeToIdMaps, typeToOffset} = serializedAnnotations;
      let pickId = 0;
      if (renderContext.emitPickID) {
        pickId = renderContext.pickIDs.register(this, chunk.numPickIds, 0, 0, chunk);
      }
      const hoverValue = base.hoverState.value;
      const modelViewProjectionMatrix = mat4.multiply(
          tempMat, renderContext.projectionParameters.viewProjectionMat,
          chunkDisplayTransform.displaySubspaceModelMatrix);
      const context: AnnotationRenderContext = {
        annotationLayer: base,
        renderContext,
        selectedIndex: 0,
        basePickId: pickId,
        buffer: chunk.buffer!,
        bufferOffset: 0,
        count: 0,
        modelViewProjectionMatrix,
        modelClipBounds: state.modelClipBounds,
        subspaceMatrix: state.renderSubspaceTransform,
        renderSubspaceModelMatrix: chunkDisplayTransform.displaySubspaceModelMatrix,
        renderSubspaceInvModelMatrix: chunkDisplayTransform.displaySubspaceInvModelMatrix,
      };
      let totalCount = 0;
      for (const annotationType of annotationTypes) {
        totalCount += typeToIdMaps[annotationType].size;
      }
      let drawFraction = Number.isFinite(maxCount) ? Math.min(1, maxCount / totalCount) : 1;
      for (const annotationType of annotationTypes) {
        const idMap = typeToIdMaps[annotationType];
        let count = idMap.size;
        if (count > 0) {
          const handler = getAnnotationTypeRenderHandler(annotationType);
          let selectedIndex = 0xFFFFFFFF;
          if (hoverValue !== undefined) {
            const index = idMap.get(hoverValue.id);
            if (index !== undefined) {
              selectedIndex = index * handler.pickIdsPerInstance;
              // If we wanted to include the partIndex, we would add:
              // selectedIndex += hoverValue.partIndex;
            }
          }
          count = Math.round(count * drawFraction);
          context.count = count;
          context.bufferOffset = typeToOffset[annotationType];
          context.selectedIndex = selectedIndex;
          this.renderHelpers[annotationType].draw(context);
          context.basePickId += count * handler.pickIdsPerInstance;
        }
      }
    }

    updateMouseState(
        mouseState: MouseSelectionState, _pickedValue: Uint64, pickedOffset: number, data: any) {
      const chunk = data as AnnotationGeometryDataInterface;
      const {serializedAnnotations} = chunk;
      const {typeToIds, typeToOffset} = serializedAnnotations;
      const rank = this.curRank;
      const chunkTransform = this.chunkTransform;
      if (chunkTransform.error !== undefined) return;
      for (const annotationType of annotationTypes) {
        const ids = typeToIds[annotationType];
        const renderHandler = getAnnotationTypeRenderHandler(annotationType);
        const handler = getAnnotationTypeHandler(annotationType);
        const {pickIdsPerInstance} = renderHandler;
        if (pickedOffset < ids.length * pickIdsPerInstance) {
          const instanceIndex = Math.floor(pickedOffset / pickIdsPerInstance);
          const id = ids[instanceIndex];
          const partIndex = pickedOffset % pickIdsPerInstance;
          mouseState.pickedAnnotationId = id;
          mouseState.pickedAnnotationLayer = this.base.state;
          mouseState.pickedOffset = partIndex;
          mouseState.pickedAnnotationBuffer = serializedAnnotations.data.buffer;
          mouseState.pickedAnnotationBufferOffset = serializedAnnotations.data.byteOffset +
              typeToOffset[annotationType] +
              instanceIndex *
                  (handler.serializedBytes(rank) +
                   this.base.source.annotationPropertySerializer.serializedBytes);
          const chunkPosition = this.tempChunkPosition;
          const {chunkToLayerTransform, combinedGlobalLocalToChunkTransform, layerRank} =
              chunkTransform;
          const {globalToRenderLayerDimensions} = chunkTransform.modelTransform;
          const {position: mousePosition} = mouseState;
          if (!getChunkPositionFromCombinedGlobalLocalPositions(
                  chunkPosition, mousePosition, this.base.state.localPosition.value, layerRank,
                  combinedGlobalLocalToChunkTransform)) {
            return;
          }
          renderHandler.snapPosition(
              chunkPosition, mouseState.pickedAnnotationBuffer,
              mouseState.pickedAnnotationBufferOffset, partIndex);
          const globalRank = globalToRenderLayerDimensions.length;
          for (let globalDim = 0; globalDim < globalRank; ++globalDim) {
            const layerDim = globalToRenderLayerDimensions[globalDim];
            if (layerDim === -1) continue;
            let sum = chunkToLayerTransform[(rank + 1) * rank + layerDim];
            for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
              sum += chunkPosition[chunkDim] *
                  chunkToLayerTransform[chunkDim * (layerRank + 1) + layerDim];
            }
            if (!Number.isFinite(sum)) {
              continue;
            }
            mousePosition[globalDim] = sum;
          }
          return;
        }
        pickedOffset -= ids.length * pickIdsPerInstance;
      }
    }

    transformPickedValue(_pickedValue: Uint64, _pickedOffset: number) {
      return undefined;
    }

    isReady() {
      const {base} = this;
      const {source} = base;
      if (!(source instanceof MultiscaleAnnotationSource)) {
        return true;
      }
      const {value: segmentationStates} = this.base.segmentationStates;
      if (segmentationStates === undefined) return true;
      for (let i = 0, count = segmentationStates.length; i < count; ++i) {
        const segmentationState = segmentationStates[i];
        if (segmentationState === null) return false;
        if (segmentationState === undefined) continue;
        const chunks = source.segmentFilteredSources[i].chunks;
        let missing = false;
        forEachVisibleSegment(segmentationState, objectId => {
          const key = getObjectKey(objectId);
          if (!chunks.has(key)) {
            missing = true;
          }
        });
        if (missing) return false;
      }
      return true;
    }

    isAnnotation = true;
  }
  return C;
}

type AnnotationRenderLayer = InstanceType<ReturnType<typeof AnnotationRenderLayer>>;

const NonSpatiallyIndexedAnnotationRenderLayer =
    <TBase extends {new (...args: any[]): AnnotationRenderLayer}>(Base: TBase) =>
        class C extends Base {
  draw(
      renderContext: PerspectiveViewRenderContext|SliceViewPanelRenderContext,
      attachment: VisibleLayerInfo<LayerView, AttachmentState>) {
    const chunkRenderParameters = this.updateAttachmentState(attachment);
    if (this.curRank === 0 || chunkRenderParameters === undefined) return;
    this.updateModelClipBounds(renderContext, chunkRenderParameters);
    const {source} = this.base;
    if (source instanceof AnnotationSource) {
      const {base} = this;
      base.updateBuffer();
      this.drawGeometry(
          base as AnnotationGeometryDataInterface, renderContext, chunkRenderParameters);
    } else {
      this.drawGeometryChunkData(source.temporary.data!, renderContext, chunkRenderParameters);
      const {value: segmentationStates} = this.base.segmentationStates;
      if (segmentationStates !== undefined) {
        for (let i = 0, count = segmentationStates.length; i < count; ++i) {
          const segmentationState = segmentationStates[i];
          if (segmentationState == null) continue;
          const chunks = source.segmentFilteredSources[i].chunks;
          forEachVisibleSegment(segmentationState, objectId => {
            const key = getObjectKey(objectId);
            const chunk = chunks.get(key);
            if (chunk !== undefined && chunk.state === ChunkState.GPU_MEMORY) {
              const {data} = chunk;
              if (data === undefined) return;
              this.drawGeometryChunkData(data, renderContext, chunkRenderParameters);
            }
          });
        }
      }
    }
  }
};


const PerspectiveViewAnnotationLayerBase =
    AnnotationRenderLayer(AnnotationPerspectiveRenderLayerBase, 'perspectiveViewRenderHelper');

export class PerspectiveViewAnnotationLayer extends NonSpatiallyIndexedAnnotationRenderLayer
(PerspectiveViewAnnotationLayerBase) {}

const SpatiallyIndexedAnnotationLayer = <TBase extends AnyConstructor<AnnotationRenderLayer>>(
    Base: TBase) => {
  class SpatiallyIndexedAnnotationLayer extends(Base as AnyConstructor<AnnotationRenderLayer>) {
    renderScaleTarget: WatchableValueInterface<number>;
    renderScaleHistogram: RenderScaleHistogram;
    constructor(options: {
      annotationLayer: AnnotationLayer,
      renderScaleTarget: WatchableValueInterface<number>,
      renderScaleHistogram: RenderScaleHistogram,
    }) {
      super(options.annotationLayer);
      this.renderScaleTarget = options.renderScaleTarget;
      this.renderScaleHistogram = options.renderScaleHistogram;
      this.registerDisposer(this.renderScaleTarget.changed.add(this.redrawNeeded.dispatch));
      this.registerDisposer(this.renderScaleHistogram.visibility.add(this.visibility));
      const sharedObject = this.registerDisposer(new SharedObject());
      const rpc = this.base.chunkManager.rpc!;
      sharedObject.RPC_TYPE_ID = ANNOTATION_SPATIALLY_INDEXED_RENDER_LAYER_RPC_ID;
      sharedObject.initializeCounterpart(rpc, {
        chunkManager: this.base.chunkManager.rpcId,
        localPosition: this.registerDisposer(SharedWatchableValue.makeFromExisting(
                                                 rpc, this.base.state.localPosition))
                           .rpcId,
        renderScaleTarget: this.registerDisposer(SharedWatchableValue.makeFromExisting(
                                                     rpc, this.renderScaleTarget))
                               .rpcId,
      });
      this.backend = sharedObject;
    }

    backend: SharedObject;

    attach(attachment: VisibleLayerInfo<LayerView, SpatiallyIndexedValidAttachmentState>) {
      super.attach(attachment);
      attachment.state!.sources = attachment.registerDisposer(registerNested(
          (context: RefCounted, transform: RenderLayerTransformOrError,
           displayDimensionRenderInfo: DisplayDimensionRenderInfo) => {
            const transformedSources =
                getVolumetricTransformedSources(
                    displayDimensionRenderInfo, transform,
                    options =>
                        (this.base.state.source as MultiscaleAnnotationSource).getSources(options),
                    attachment.messages, this) as TransformedAnnotationSource[][];
            for (const scales of transformedSources) {
              for (const tsource of scales) {
                context.registerDisposer(tsource.source);
                Object.assign(
                    tsource, getAnnotationProjectionParameters(tsource.chunkDisplayTransform));
              }
            }
            attachment.view.flushBackendProjectionParameters();
            this.backend.rpc!.invoke(ANNOTATION_PERSPECTIVE_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, {
              layer: this.backend.rpcId,
              view: attachment.view.rpcId,
              sources: serializeAllTransformedSources(transformedSources),
            });
            this.redrawNeeded.dispatch();
            return transformedSources;
          },
          this.base.state.transform, attachment.view.displayDimensionRenderInfo));
    }

    draw(
        renderContext: PerspectiveViewRenderContext|SliceViewPanelRenderContext,
        attachment: VisibleLayerInfo<PerspectivePanel, SpatiallyIndexedValidAttachmentState>) {
      const chunkRenderParameters = this.updateAttachmentState(attachment);
      if (this.curRank === 0 || chunkRenderParameters === undefined) return;
      const transformedSources = attachment.state!.sources!.value;
      if (transformedSources.length === 0) return;
      this.updateModelClipBounds(renderContext, chunkRenderParameters);
      const {renderScaleHistogram} = this;
      renderScaleHistogram.begin(
          this.base.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber);
      const {projectionParameters} = renderContext;
      forEachVisibleAnnotationChunk(
          projectionParameters, this.base.state.localPosition.value, this.renderScaleTarget.value,
          transformedSources[0], () => {},
          (tsource, index, maxCount, physicalSpacing, pixelSpacing) => {
            index;
            const chunk = tsource.source.chunks.get(tsource.curPositionInChunks.join());
            let present: number;
            if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
              present = 0;
            } else {
              const {data} = chunk;
              if (data === undefined) {
                return;
              }
              this.drawGeometryChunkData(data, renderContext, chunkRenderParameters, maxCount);
              present = 1;
            }
            renderScaleHistogram.add(physicalSpacing, pixelSpacing, present, 1 - present);
          });
    }
  };
  return SpatiallyIndexedAnnotationLayer as
      MixinConstructor<typeof SpatiallyIndexedAnnotationLayer, TBase>;
};

export const SpatiallyIndexedPerspectiveViewAnnotationLayer =
    SpatiallyIndexedAnnotationLayer(PerspectiveViewAnnotationLayerBase);

export const SpatiallyIndexedSliceViewAnnotationLayer = SpatiallyIndexedAnnotationLayer(
    AnnotationRenderLayer(AnnotationSliceViewRenderLayerBase, 'sliceViewRenderHelper'));

export const SliceViewAnnotationLayer = NonSpatiallyIndexedAnnotationRenderLayer(
    AnnotationRenderLayer(AnnotationSliceViewRenderLayerBase, 'sliceViewRenderHelper'));
