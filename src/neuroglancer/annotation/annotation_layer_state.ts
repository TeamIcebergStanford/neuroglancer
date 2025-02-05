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

import {AnnotationSource} from 'neuroglancer/annotation';
import {MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {LayerDataSource} from 'neuroglancer/layer_data_source';
import {ChunkTransformParameters, getChunkTransformParameters, RenderLayerTransformOrError} from 'neuroglancer/render_coordinate_transform';
import {RenderLayerRole} from 'neuroglancer/renderlayer';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {makeCachedLazyDerivedWatchableValue, WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Owned, RefCounted} from 'neuroglancer/util/disposable';
import {makeValueOrError, ValueOrError, valueOrThrow} from 'neuroglancer/util/error';
import {vec3} from 'neuroglancer/util/geom';
import {WatchableMap} from 'neuroglancer/util/watchable_map';
import {makeTrackableFragmentMain, makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {parseShaderUiControls, ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';

export class AnnotationHoverState extends WatchableValue<
    {id: string, partIndex: number, annotationLayerState: AnnotationLayerState}|undefined> {}

export interface AnnotationRelationshipState {
  // null means loading
  // undefined means no attached layer
  segmentationState: SegmentationDisplayState|null|undefined;
  showMatches: TrackableBoolean;
}

export class WatchableAnnotationRelationshipStates extends
    WatchableMap<string, AnnotationRelationshipState> {
  constructor() {
    super(
        state => {
          state.showMatches.changed.add(this.changed.dispatch);
        },
        state => {
          state.showMatches.changed.remove(this.changed.dispatch);
        });
  }

  get(name: string): AnnotationRelationshipState {
    let value = super.get(name);
    if (value === undefined) {
      value = {segmentationState: undefined, showMatches: new TrackableBoolean(false)};
      super.set(name, value);
    }
    return value;
  }
}

const DEFAULT_FRAGMENT_MAIN = `
void main() {
  setColor(defaultColor());
}
`;

export class AnnotationDisplayState extends RefCounted {
  shader = makeTrackableFragmentMain(DEFAULT_FRAGMENT_MAIN);
  shaderControls = new ShaderControlState(this.shader);
  fallbackShaderControls = new WatchableValue(parseShaderUiControls(DEFAULT_FRAGMENT_MAIN));
  shaderError = makeWatchableShaderError();
  color = new TrackableRGB(vec3.fromValues(1, 1, 0));
  relationshipStates = this.registerDisposer(new WatchableAnnotationRelationshipStates());
  displayUnfiltered = makeCachedLazyDerivedWatchableValue(map => {
    let value = true;
    for (const state of map.values()) {
      if (state.showMatches.value) {
        value = false;
        break;
      }
    }
    return value;
  }, this.relationshipStates);
  hoverState = new AnnotationHoverState(undefined);
}

export class AnnotationLayerState extends RefCounted {
  transform: WatchableValueInterface<RenderLayerTransformOrError>;
  localPosition: WatchableValueInterface<Float32Array>;
  source: Owned<AnnotationSource|MultiscaleAnnotationSource>;
  role: RenderLayerRole;
  dataSource: LayerDataSource;
  subsourceId: string;
  subsourceIndex: number;
  displayState: AnnotationDisplayState;

  readonly chunkTransform: WatchableValueInterface<ValueOrError<ChunkTransformParameters>>;

  constructor(options: {
    transform: WatchableValueInterface<RenderLayerTransformOrError>,
    localPosition: WatchableValueInterface<Float32Array>,
    source: Owned<AnnotationSource|MultiscaleAnnotationSource>,
    displayState: AnnotationDisplayState,
    dataSource: LayerDataSource,
    subsourceId: string,
    subsourceIndex: number,
    role?: RenderLayerRole,
  }) {
    super();
    const {
      transform,
      localPosition,
      source,
      role = RenderLayerRole.ANNOTATION,
    } = options;
    this.transform = transform;
    this.localPosition = localPosition;
    this.source = this.registerDisposer(source);
    this.role = role;
    this.displayState = options.displayState;
    this.chunkTransform = this.registerDisposer(makeCachedLazyDerivedWatchableValue(
        modelTransform =>
            makeValueOrError(() => getChunkTransformParameters(valueOrThrow(modelTransform))),
        this.transform));
    this.dataSource = options.dataSource;
    this.subsourceId = options.subsourceId;
    this.subsourceIndex = options.subsourceIndex;
  }

  get sourceIndex() {
    const {dataSource} = this;
    return dataSource.layer.dataSources.indexOf(dataSource);
  }
}
