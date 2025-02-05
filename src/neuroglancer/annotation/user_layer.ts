/**
 * @license
 * Copyright 2016 Google Inc.
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

import './user_layer.css';

import {AnnotationPropertySpec, AnnotationType, LocalAnnotationSource} from 'neuroglancer/annotation';
import {AnnotationDisplayState, AnnotationLayerState} from 'neuroglancer/annotation/annotation_layer_state';
import {SpatiallyIndexedPerspectiveViewAnnotationLayer} from 'neuroglancer/annotation/renderlayer';
import {CoordinateTransformSpecification, makeCoordinateSpace} from 'neuroglancer/coordinate_transform';
import {DataSourceSpecification, localAnnotationsUrl, LocalDataSource} from 'neuroglancer/datasource';
import {LayerManager, LayerReference, ManagedUserLayer, registerLayerType, registerLayerTypeDetector, UserLayer} from 'neuroglancer/layer';
import {LoadedDataSubsource} from 'neuroglancer/layer_data_source';
import {Overlay} from 'neuroglancer/overlay';
import {getWatchableRenderLayerTransform} from 'neuroglancer/render_coordinate_transform';
import {RenderLayerRole} from 'neuroglancer/renderlayer';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {makeCachedLazyDerivedWatchableValue, WatchableValue} from 'neuroglancer/trackable_value';
import {AnnotationLayerView, MergedAnnotationStates, UserLayerWithAnnotationsMixin} from 'neuroglancer/ui/annotations';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {updateChildren} from 'neuroglancer/util/dom';
import {parseArray, parseFixedLengthArray, stableStringify, verify3dVec, verifyFinitePositiveFloat, verifyObject, verifyOptionalObjectProperty, verifyString, verifyStringArray} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {DependentViewWidget} from 'neuroglancer/widget/dependent_view_widget';
import {makeHelpButton} from 'neuroglancer/widget/help_button';
import {LayerReferenceWidget} from 'neuroglancer/widget/layer_reference';
import {makeMaximizeButton} from 'neuroglancer/widget/maximize_button';
import {RenderScaleWidget} from 'neuroglancer/widget/render_scale_widget';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {ShaderControls} from 'neuroglancer/widget/shader_controls';
import {Tab} from 'neuroglancer/widget/tab_view';

const POINTS_JSON_KEY = 'points';
const ANNOTATIONS_JSON_KEY = 'annotations';
const CROSS_SECTION_RENDER_SCALE_JSON_KEY = 'crossSectionAnnotationSpacing';
const PROJECTION_RENDER_SCALE_JSON_KEY = 'projectionAnnotationSpacing';

function addPointAnnotations(annotations: LocalAnnotationSource, obj: any) {
  if (obj === undefined) {
    return;
  }
  parseArray(obj, (x, i) => {
    annotations.add({
      type: AnnotationType.POINT,
      id: '' + i,
      point: verify3dVec(x),
      properties: [],
    });
  });
}

function isValidLinkedSegmentationLayer(layer: ManagedUserLayer) {
  const userLayer = layer.layer;
  if (userLayer === null) {
    return true;
  }
  if (userLayer instanceof SegmentationUserLayer) {
    return true;
  }
  return false;
}

function getSegmentationDisplayState(layer: ManagedUserLayer|undefined): SegmentationDisplayState|
    null {
  if (layer === undefined) {
    return null;
  }
  const userLayer = layer.layer;
  if (userLayer === null) {
    return null;
  }
  if (!(userLayer instanceof SegmentationUserLayer)) {
    return null;
  }
  return userLayer.displayState;
}

interface LinkedSegmentationLayer {
  layerRef: Owned<LayerReference>;
  showMatches: TrackableBoolean;
  seenGeneration: number;
}

const LINKED_SEGMENTATION_LAYER_JSON_KEY = 'linkedSegmentationLayer';
const FILTER_BY_SEGMENTATION_JSON_KEY = 'filterBySegmentation';

class LinkedSegmentationLayers extends RefCounted {
  changed = new NullarySignal();
  private curGeneration = -1;
  private wasLoading: boolean|undefined = undefined;
  constructor(
      public layerManager: Borrowed<LayerManager>,
      public annotationStates: Borrowed<MergedAnnotationStates>,
      public annotationDisplayState: Borrowed<AnnotationDisplayState>) {
    super();
    this.registerDisposer(annotationStates.changed.add(() => this.update()));
    this.registerDisposer(annotationStates.isLoadingChanged.add(() => this.update()));
    this.update();
  }

  private update() {
    const generation = this.annotationStates.changed.count;
    const isLoading = this.annotationStates.isLoading;
    if (this.curGeneration === generation && isLoading === this.wasLoading) return;
    this.wasLoading = isLoading;
    this.curGeneration = generation;
    const {map} = this;
    let changed = false;
    for (const relationship of this.annotationStates.relationships) {
      let state = map.get(relationship);
      if (state === undefined) {
        state = this.addRelationship(relationship);
        changed = true;
      }
      state.seenGeneration = generation;
    }
    if (!isLoading) {
      for (const [relationship, state] of map) {
        if (state.seenGeneration !== generation) {
          map.delete(relationship);
          changed = true;
        }
      }
    }
    if (changed) {
      this.changed.dispatch();
    }
  }

  private addRelationship(relationship: string): LinkedSegmentationLayer {
    const relationshipState = this.annotationDisplayState.relationshipStates.get(relationship);
    const layerRef = new LayerReference(this.layerManager.addRef(), isValidLinkedSegmentationLayer);
    layerRef.registerDisposer(layerRef.changed.add(() => {
      const prevValue = relationshipState.segmentationState;
      if (layerRef.layerName === undefined) {
        relationshipState.segmentationState = undefined;
      } else {
        const {layer} = layerRef;
        relationshipState.segmentationState = getSegmentationDisplayState(layer);
      }
      if (prevValue !== relationshipState.segmentationState) {
        this.annotationDisplayState.relationshipStates.changed.dispatch();
      }
    }));
    const {showMatches} = relationshipState;
    const state = {
      layerRef,
      showMatches,
      seenGeneration: -1,
    };
    layerRef.changed.add(this.changed.dispatch);
    showMatches.changed.add(this.changed.dispatch);
    this.map.set(relationship, state);
    return state;
  }

  get(relationship: string): LinkedSegmentationLayer {
    this.update();
    return this.map.get(relationship)!;
  }

  private unbind(state: LinkedSegmentationLayer) {
    state.layerRef.changed.remove(this.changed.dispatch);
    state.showMatches.changed.remove(this.changed.dispatch);
  }

  reset() {
    for (const state of this.map.values()) {
      state.showMatches.reset();
    }
  }

  toJSON() {
    const {map} = this;
    if (map.size === 0) return {};
    let linkedJson: {[relationship: string]: string}|undefined = undefined;
    const filterBySegmentation = [];
    for (const [name, state] of map) {
      if (state.showMatches.value) {
        filterBySegmentation.push(name);
      }
      const {layerName} = state.layerRef;
      if (layerName !== undefined) {
        (linkedJson = linkedJson || {})[name] = layerName;
      }
    }
    filterBySegmentation.sort();
    return {
      [LINKED_SEGMENTATION_LAYER_JSON_KEY]: linkedJson,
      [FILTER_BY_SEGMENTATION_JSON_KEY]:
          filterBySegmentation.length === 0 ? undefined : filterBySegmentation,
    };
  }
  restoreState(json: any) {
    const {isLoading} = this.annotationStates;
    verifyOptionalObjectProperty(json, LINKED_SEGMENTATION_LAYER_JSON_KEY, linkedJson => {
      if (typeof linkedJson === 'string') {
        linkedJson = {'segments': linkedJson};
      }
      verifyObject(linkedJson);
      for (const key of Object.keys(linkedJson)) {
        const value = verifyString(linkedJson[key]);
        let state = this.map.get(key);
        if (state === undefined) {
          if (!isLoading) continue;
          state = this.addRelationship(key);
        }
        state.layerRef.layerName = value;
      }
      for (const [relationship, state] of this.map) {
        if (!Object.prototype.hasOwnProperty.call(linkedJson, relationship)) {
          state.layerRef.layerName = undefined;
        }
      }
    });
    verifyOptionalObjectProperty(json, FILTER_BY_SEGMENTATION_JSON_KEY, filterJson => {
      if (typeof filterJson === 'boolean') {
        filterJson = (filterJson === true) ? ['segments'] : [];
      }
      for (const key of verifyStringArray(filterJson)) {
        let state = this.map.get(key);
        if (state === undefined) {
          if (!isLoading) continue;
          state = this.addRelationship(key);
        }
        state.showMatches.value = true;
      }
    });
  }

  disposed() {
    const {map} = this;
    for (const state of map.values()) {
      this.unbind(state);
    }
    map.clear();
    super.disposed();
  }
  private map = new Map<string, LinkedSegmentationLayer>();
}

class LinkedSegmentationLayerWidget extends RefCounted {
  element = document.createElement('label');
  seenGeneration = -1;
  constructor(public relationship: string, public state: LinkedSegmentationLayer) {
    super();
    const {element} = this;
    const checkboxWidget = this.registerDisposer(new TrackableBooleanCheckbox(state.showMatches));
    const layerWidget = new LayerReferenceWidget(state.layerRef);
    element.appendChild(checkboxWidget.element);
    element.appendChild(document.createTextNode(relationship));
    element.appendChild(layerWidget.element);
  }
}

class LinkedSegmentationLayersWidget extends RefCounted {
  widgets = new Map<string, LinkedSegmentationLayerWidget>();
  element = document.createElement('div');
  constructor(public linkedSegmentationLayers: LinkedSegmentationLayers) {
    super();
    this.element.style.display = 'contents';
    const debouncedUpdateView =
        this.registerCancellable(animationFrameDebounce(() => this.updateView()));
    this.registerDisposer(
        this.linkedSegmentationLayers.annotationStates.changed.add(debouncedUpdateView));
    this.updateView();
  }

  private updateView() {
    const {linkedSegmentationLayers} = this;
    const {annotationStates} = linkedSegmentationLayers;
    const generation = annotationStates.changed.count;
    const {widgets} = this;
    function* getChildren(this: LinkedSegmentationLayersWidget) {
      for (const relationship of annotationStates.relationships) {
        let widget = widgets.get(relationship);
        if (widget === undefined) {
          widget = new LinkedSegmentationLayerWidget(
              relationship, linkedSegmentationLayers.get(relationship));
        }
        widget.seenGeneration = generation;
        yield widget.element;
      }
    }
    for (const [relationship, widget] of widgets) {
      if (widget.seenGeneration !== generation) {
        widget.dispose();
        widgets.delete(relationship);
      }
    }
    updateChildren(this.element, getChildren.call(this));
  }

  disposed() {
    super.disposed();
    for (const widget of this.widgets.values()) {
      widget.dispose();
    }
  }
}

const Base = UserLayerWithAnnotationsMixin(UserLayer);
export class AnnotationUserLayer extends Base {
  localAnnotations: LocalAnnotationSource|undefined;
  annotationProperties = new WatchableValue<AnnotationPropertySpec[]|undefined>(undefined);
  private localAnnotationsJson: any = undefined;
  private pointAnnotationsJson: any = undefined;
  linkedSegmentationLayers = this.registerDisposer(new LinkedSegmentationLayers(
      this.manager.rootLayers, this.annotationStates, this.annotationDisplayState));

  disposed() {
    const {localAnnotations} = this;
    if (localAnnotations !== undefined) {
      localAnnotations.dispose();
    }
    super.disposed();
  }

  constructor(managedLayer: Borrowed<ManagedUserLayer>, specification: any) {
    super(managedLayer, specification);
    this.linkedSegmentationLayers.restoreState(specification);
    this.linkedSegmentationLayers.changed.add(this.specificationChanged.dispatch);
    this.annotationCrossSectionRenderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.localAnnotationsJson = specification[ANNOTATIONS_JSON_KEY];
    this.pointAnnotationsJson = specification[POINTS_JSON_KEY];
    this.annotationCrossSectionRenderScaleTarget.restoreState(
        specification[CROSS_SECTION_RENDER_SCALE_JSON_KEY]);
    this.annotationProjectionRenderScaleTarget.restoreState(
        specification[PROJECTION_RENDER_SCALE_JSON_KEY]);
    this.tabs.add(
        'rendering',
        {label: 'Rendering', order: -100, getter: () => new RenderingOptionsTab(this)});
    this.tabs.default = 'annotations';
  }

  getLegacyDataSourceSpecifications(
      sourceSpec: any, layerSpec: any,
      legacyTransform: CoordinateTransformSpecification|undefined): DataSourceSpecification[] {
    if (Object.prototype.hasOwnProperty.call(layerSpec, 'source')) {
      return super.getLegacyDataSourceSpecifications(sourceSpec, layerSpec, legacyTransform);
    }
    const scales = verifyOptionalObjectProperty(
        layerSpec, 'voxelSize',
        voxelSizeObj => parseFixedLengthArray(
            new Float64Array(3), voxelSizeObj, x => verifyFinitePositiveFloat(x) / 1e9));
    const units = ['m', 'm', 'm'];
    if (scales !== undefined) {
      const inputSpace = makeCoordinateSpace({rank: 3, units, scales, names: ['x', 'y', 'z']});
      if (legacyTransform === undefined) {
        legacyTransform = {
          outputSpace: inputSpace,
          sourceRank: 3,
          transform: undefined,
          inputSpace,
        };
      } else {
        legacyTransform = {
          ...legacyTransform,
          inputSpace,
        };
      }
    }
    return [{
      url: localAnnotationsUrl,
      transform: legacyTransform,
      enableDefaultSubsources: true,
      subsources: new Map(),
    }];
  }

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    let hasLocalAnnotations = false;
    let properties: AnnotationPropertySpec[]|undefined;
    for (const loadedSubsource of subsources) {
      const {subsourceEntry} = loadedSubsource;
      const {local} = subsourceEntry.subsource;
      if (local === LocalDataSource.annotations) {
        if (hasLocalAnnotations) {
          loadedSubsource.deactivate('Only one local annotations source per layer is supported');
          continue;
        }
        hasLocalAnnotations = true;
        loadedSubsource.activate(refCounted => {
          const localAnnotations = this.localAnnotations =
              new LocalAnnotationSource(loadedSubsource.loadedDataSource.transform);
          try {
            localAnnotations.restoreState(this.localAnnotationsJson);
          } catch {
          }
          refCounted.registerDisposer(() => {
            localAnnotations.dispose();
            this.localAnnotations = undefined;
          });
          refCounted.registerDisposer(
              this.localAnnotations.changed.add(this.specificationChanged.dispatch));
          try {
            addPointAnnotations(this.localAnnotations, this.pointAnnotationsJson);
          } catch {
          }
          this.pointAnnotationsJson = undefined;
          this.localAnnotationsJson = undefined;

          const state = new AnnotationLayerState({
            localPosition: this.localPosition,
            transform: refCounted.registerDisposer(getWatchableRenderLayerTransform(
                this.manager.root.coordinateSpace, this.localPosition.coordinateSpace,
                loadedSubsource.loadedDataSource.transform, undefined)),
            source: localAnnotations.addRef(),
            displayState: this.annotationDisplayState,
            dataSource: loadedSubsource.loadedDataSource.layerDataSource,
            subsourceIndex: loadedSubsource.subsourceIndex,
            subsourceId: subsourceEntry.id,
            role: RenderLayerRole.ANNOTATION,
          });
          this.addAnnotationLayerState(state, loadedSubsource);
        });
        continue;
      }
      const {annotation} = subsourceEntry.subsource;
      if (annotation !== undefined) {
        if (properties !== undefined &&
            stableStringify(annotation.properties) !== stableStringify(properties)) {
          loadedSubsource.deactivate('Annotation properties are not compatible');
          continue;
        }
        properties = annotation.properties;
        loadedSubsource.activate(() => {
          const state = new AnnotationLayerState({
            localPosition: this.localPosition,
            transform: loadedSubsource.getRenderLayerTransform(),
            source: annotation,
            displayState: this.annotationDisplayState,
            dataSource: loadedSubsource.loadedDataSource.layerDataSource,
            subsourceIndex: loadedSubsource.subsourceIndex,
            subsourceId: subsourceEntry.id,
            role: RenderLayerRole.ANNOTATION,
          });
          this.addAnnotationLayerState(state, loadedSubsource);
        });
        continue;
      }
      loadedSubsource.deactivate('Not compatible with annotation layer');
    }
    const prevAnnotationProperties = this.annotationProperties.value;
    if (stableStringify(prevAnnotationProperties) !== stableStringify(properties)) {
      this.annotationProperties.value = properties;
    }
  }

  initializeAnnotationLayerViewTab(tab: AnnotationLayerView) {
    const hasChunkedSource = tab.registerDisposer(makeCachedLazyDerivedWatchableValue(
        layers => layers.some(x => (x instanceof SpatiallyIndexedPerspectiveViewAnnotationLayer)),
        {changed: this.layersChanged, value: this.renderLayers}));
    const renderScaleControls = tab.registerDisposer(
        new DependentViewWidget(hasChunkedSource, (hasChunkedSource, parent, refCounted) => {
          if (!hasChunkedSource) return;
          {
            const renderScaleWidget = refCounted.registerDisposer(new RenderScaleWidget(
                this.annotationCrossSectionRenderScaleHistogram,
                this.annotationCrossSectionRenderScaleTarget));
            renderScaleWidget.label.textContent = 'Spacing (cross section)';
            parent.appendChild(renderScaleWidget.element);
          }
          {
            const renderScaleWidget = refCounted.registerDisposer(new RenderScaleWidget(
                this.annotationProjectionRenderScaleHistogram,
                this.annotationProjectionRenderScaleTarget));
            renderScaleWidget.label.textContent = 'Spacing (projection)';
            parent.appendChild(renderScaleWidget.element);
          }
        }));
    tab.element.insertBefore(renderScaleControls.element, tab.element.firstChild);
    tab.element.appendChild(
        tab.registerDisposer(new LinkedSegmentationLayersWidget(this.linkedSegmentationLayers))
            .element);
  }

  toJSON() {
    const x = super.toJSON();
    x[CROSS_SECTION_RENDER_SCALE_JSON_KEY] = this.annotationCrossSectionRenderScaleTarget.toJSON();
    x[PROJECTION_RENDER_SCALE_JSON_KEY] = this.annotationProjectionRenderScaleTarget.toJSON();
    if (this.localAnnotations !== undefined) {
      x[ANNOTATIONS_JSON_KEY] = this.localAnnotations.toJSON();
    } else if (this.localAnnotationsJson !== undefined) {
      x[ANNOTATIONS_JSON_KEY] = this.localAnnotationsJson;
    }
    Object.assign(x, this.linkedSegmentationLayers.toJSON());
    return x;
  }

  static type = 'annotation';
}

function makeShaderCodeWidget(layer: AnnotationUserLayer) {
  return new ShaderCodeWidget({
    shaderError: layer.annotationDisplayState.shaderError,
    fragmentMain: layer.annotationDisplayState.shader,
    shaderControlState: layer.annotationDisplayState.shaderControls,
  });
}

class ShaderCodeOverlay extends Overlay {
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: AnnotationUserLayer) {
    super();
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}

class RenderingOptionsTab extends Tab {
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: AnnotationUserLayer) {
    super();
    const {element} = this;
    element.appendChild(
        this
            .registerDisposer(new DependentViewWidget(
                layer.annotationProperties,
                (properties, parent) => {
                  if (properties === undefined) return;
                  for (const property of properties) {
                    const div = document.createElement('div');
                    div.classList.add('neuroglancer-annotation-shader-property');
                    const typeElement = document.createElement('span');
                    typeElement.classList.add('neuroglancer-annotation-shader-property-type');
                    typeElement.textContent = property.type;
                    const nameElement = document.createElement('span');
                    nameElement.classList.add('neuroglancer-annotation-shader-property-identifier');
                    nameElement.textContent = `prop_${property.identifier}`;
                    div.appendChild(typeElement);
                    div.appendChild(nameElement);
                    const {description} = property;
                    if (description !== undefined) {
                      div.title = description;
                    }
                    parent.appendChild(div);
                  }
                }))
            .element);
    let topRow = document.createElement('div');
    topRow.className = 'neuroglancer-segmentation-dropdown-skeleton-shader-header';
    let label = document.createElement('div');
    label.style.flex = '1';
    label.textContent = 'Annotation shader:';
    topRow.appendChild(label);
    topRow.appendChild(makeMaximizeButton({
      title: 'Show larger editor view',
      onClick: () => {
        new ShaderCodeOverlay(this.layer);
      }
    }));
    topRow.appendChild(makeHelpButton({
      title: 'Documentation on annotation rendering',
      href:
          'https://github.com/google/neuroglancer/blob/master/src/neuroglancer/annotation/rendering.md',
    }));
    element.appendChild(topRow);

    element.appendChild(this.codeWidget.element);
    element.appendChild(
        this.registerDisposer(new ShaderControls(layer.annotationDisplayState.shaderControls))
            .element);
  }
}

registerLayerType('annotation', AnnotationUserLayer);
registerLayerType('pointAnnotation', AnnotationUserLayer);
registerLayerTypeDetector(subsource => {
  if (subsource.local === LocalDataSource.annotations) return AnnotationUserLayer;
  if (subsource.annotation !== undefined) return AnnotationUserLayer;
  return undefined;
});
