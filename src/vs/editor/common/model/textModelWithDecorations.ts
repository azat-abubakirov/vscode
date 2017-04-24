/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { onUnexpectedError } from 'vs/base/common/errors';
import { MarkedString, markedStringsEquals } from 'vs/base/common/htmlContent';
import * as strings from 'vs/base/common/strings';
import { CharCode } from 'vs/base/common/charCode';
import { Range, IRange } from 'vs/editor/common/core/range';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { MarkersTracker, LineMarker } from 'vs/editor/common/model/modelLine';
import { Position } from 'vs/editor/common/core/position';
import { INewMarker, TextModelWithMarkers } from 'vs/editor/common/model/textModelWithMarkers';
import { LanguageIdentifier } from 'vs/editor/common/modes';
import { ITextSource, IRawTextSource } from 'vs/editor/common/model/textSource';
import * as textModelEvents from 'vs/editor/common/model/textModelEvents';

export const ClassName = {
	EditorWarningDecoration: 'greensquiggly',
	EditorErrorDecoration: 'redsquiggly'
};

class DecorationsTracker {

	public addedDecorations: string[];
	public addedDecorationsLen: number;
	public changedDecorations: string[];
	public changedDecorationsLen: number;
	public removedDecorations: string[];
	public removedDecorationsLen: number;

	constructor() {
		this.addedDecorations = [];
		this.addedDecorationsLen = 0;
		this.changedDecorations = [];
		this.changedDecorationsLen = 0;
		this.removedDecorations = [];
		this.removedDecorationsLen = 0;
	}

	// --- Build decoration events

	public addNewDecoration(id: string): void {
		this.addedDecorations[this.addedDecorationsLen++] = id;
	}

	public addRemovedDecoration(id: string): void {
		this.removedDecorations[this.removedDecorationsLen++] = id;
	}

	public addMovedDecoration(id: string): void {
		this.changedDecorations[this.changedDecorationsLen++] = id;
	}

	public addUpdatedDecoration(id: string): void {
		this.changedDecorations[this.changedDecorationsLen++] = id;
	}
}

export class InternalDecoration implements editorCommon.IModelDecoration {
	_internalDecorationBrand: void;

	public readonly id: string;
	public readonly internalId: number;
	public readonly ownerId: number;
	public readonly startMarker: LineMarker;
	public readonly endMarker: LineMarker;
	public options: ModelDecorationOptions;
	public isForValidation: boolean;
	public range: Range;

	constructor(id: string, internalId: number, ownerId: number, range: Range, startMarker: LineMarker, endMarker: LineMarker, options: ModelDecorationOptions) {
		this.id = id;
		this.internalId = internalId;
		this.ownerId = ownerId;
		this.range = range;
		this.startMarker = startMarker;
		this.endMarker = endMarker;
		this.setOptions(options);
	}

	public setOptions(options: ModelDecorationOptions) {
		this.options = options;
		this.isForValidation = (
			this.options.className === ClassName.EditorErrorDecoration
			|| this.options.className === ClassName.EditorWarningDecoration
		);
	}

	public setRange(multiLineDecorationsMap: { [key: string]: InternalDecoration; }, range: Range): void {
		if (this.range.equalsRange(range)) {
			return;
		}

		let rangeWasMultiLine = (this.range.startLineNumber !== this.range.endLineNumber);
		this.range = range;
		let rangeIsMultiline = (this.range.startLineNumber !== this.range.endLineNumber);

		if (rangeWasMultiLine === rangeIsMultiline) {
			return;
		}

		if (rangeIsMultiline) {
			multiLineDecorationsMap[this.id] = this;
		} else {
			delete multiLineDecorationsMap[this.id];
		}
	}
}

let _INSTANCE_COUNT = 0;
/**
 * Produces 'a'-'z', followed by 'A'-'Z'... followed by 'a'-'z', etc.
 */
function nextInstanceId(): string {
	const LETTERS_CNT = (CharCode.Z - CharCode.A + 1);

	let result = _INSTANCE_COUNT++;
	result = result % (2 * LETTERS_CNT);

	if (result < LETTERS_CNT) {
		return String.fromCharCode(CharCode.a + result);
	}

	return String.fromCharCode(CharCode.A + result - LETTERS_CNT);
}

export class TextModelWithDecorations extends TextModelWithMarkers implements editorCommon.ITextModelWithDecorations {

	/**
	 * Used to workaround broken clients that might attempt using a decoration id generated by a different model.
	 * It is not globally unique in order to limit it to one character.
	 */
	private readonly _instanceId: string;
	private _lastDecorationId: number;

	private _currentDecorationsTracker: DecorationsTracker;
	private _currentDecorationsTrackerCnt: number;

	private _currentMarkersTracker: MarkersTracker;
	private _currentMarkersTrackerCnt: number;

	private _decorations: { [decorationId: string]: InternalDecoration; };
	private _internalDecorations: { [internalDecorationId: number]: InternalDecoration; };
	private _multiLineDecorationsMap: { [key: string]: InternalDecoration; };

	constructor(rawTextSource: IRawTextSource, creationOptions: editorCommon.ITextModelCreationOptions, languageIdentifier: LanguageIdentifier) {
		super(rawTextSource, creationOptions, languageIdentifier);

		this._instanceId = nextInstanceId();
		this._lastDecorationId = 0;

		// Initialize decorations
		this._currentDecorationsTracker = null;
		this._currentDecorationsTrackerCnt = 0;

		this._currentMarkersTracker = null;
		this._currentMarkersTrackerCnt = 0;

		this._decorations = Object.create(null);
		this._internalDecorations = Object.create(null);
		this._multiLineDecorationsMap = Object.create(null);
	}

	public dispose(): void {
		this._decorations = null;
		this._internalDecorations = null;
		this._multiLineDecorationsMap = null;
		super.dispose();
	}

	protected _resetValue(newValue: ITextSource): void {
		super._resetValue(newValue);

		// Destroy all my decorations
		this._decorations = Object.create(null);
		this._internalDecorations = Object.create(null);
		this._multiLineDecorationsMap = Object.create(null);
	}

	private static _shouldStartMarkerSticksToPreviousCharacter(stickiness: editorCommon.TrackedRangeStickiness): boolean {
		if (stickiness === editorCommon.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges || stickiness === editorCommon.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore) {
			return true;
		}
		return false;
	}

	private static _shouldEndMarkerSticksToPreviousCharacter(stickiness: editorCommon.TrackedRangeStickiness): boolean {
		if (stickiness === editorCommon.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges || stickiness === editorCommon.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore) {
			return true;
		}
		return false;
	}

	_getTrackedRangesCount(): number {
		return Object.keys(this._decorations).length;
	}

	// --- END TrackedRanges

	public changeDecorations<T>(callback: (changeAccessor: editorCommon.IModelDecorationsChangeAccessor) => T, ownerId: number = 0): T {
		this._assertNotDisposed();

		try {
			this._eventEmitter.beginDeferredEmit();
			let decorationsTracker = this._acquireDecorationsTracker();
			return this._changeDecorations(decorationsTracker, ownerId, callback);
		} finally {
			this._releaseDecorationsTracker();
			this._eventEmitter.endDeferredEmit();
		}
	}

	private _changeDecorations<T>(decorationsTracker: DecorationsTracker, ownerId: number, callback: (changeAccessor: editorCommon.IModelDecorationsChangeAccessor) => T): T {
		let changeAccessor: editorCommon.IModelDecorationsChangeAccessor = {
			addDecoration: (range: IRange, options: editorCommon.IModelDecorationOptions): string => {
				return this._addDecorationImpl(decorationsTracker, ownerId, this.validateRange(range), _normalizeOptions(options));
			},
			changeDecoration: (id: string, newRange: IRange): void => {
				this._changeDecorationImpl(decorationsTracker, id, this.validateRange(newRange));
			},
			changeDecorationOptions: (id: string, options: editorCommon.IModelDecorationOptions) => {
				this._changeDecorationOptionsImpl(decorationsTracker, id, _normalizeOptions(options));
			},
			removeDecoration: (id: string): void => {
				this._removeDecorationImpl(decorationsTracker, id);
			},
			deltaDecorations: (oldDecorations: string[], newDecorations: editorCommon.IModelDeltaDecoration[]): string[] => {
				return this._deltaDecorationsImpl(decorationsTracker, ownerId, oldDecorations, this._normalizeDeltaDecorations(newDecorations));
			}
		};
		let result: T = null;
		try {
			result = callback(changeAccessor);
		} catch (e) {
			onUnexpectedError(e);
		}
		// Invalidate change accessor
		changeAccessor.addDecoration = null;
		changeAccessor.changeDecoration = null;
		changeAccessor.removeDecoration = null;
		changeAccessor.deltaDecorations = null;
		return result;
	}

	public deltaDecorations(oldDecorations: string[], newDecorations: editorCommon.IModelDeltaDecoration[], ownerId: number = 0): string[] {
		this._assertNotDisposed();
		if (!oldDecorations) {
			oldDecorations = [];
		}
		return this.changeDecorations((changeAccessor) => {
			return changeAccessor.deltaDecorations(oldDecorations, newDecorations);
		}, ownerId);
	}

	public removeAllDecorationsWithOwnerId(ownerId: number): void {
		let toRemove: string[] = [];

		for (let decorationId in this._decorations) {
			// No `hasOwnProperty` call due to using Object.create(null)

			let decoration = this._decorations[decorationId];

			if (decoration.ownerId === ownerId) {
				toRemove.push(decoration.id);
			}
		}

		this._removeDecorationsImpl(null, toRemove);
	}

	public getDecorationOptions(decorationId: string): editorCommon.IModelDecorationOptions {
		let decoration = this._decorations[decorationId];
		if (!decoration) {
			return null;
		}
		return decoration.options;
	}

	public getDecorationRange(decorationId: string): Range {
		let decoration = this._decorations[decorationId];
		if (!decoration) {
			return null;
		}
		return decoration.range;
	}

	public getLineDecorations(lineNumber: number, ownerId: number = 0, filterOutValidation: boolean = false): editorCommon.IModelDecoration[] {
		if (lineNumber < 1 || lineNumber > this.getLineCount()) {
			return [];
		}

		return this.getLinesDecorations(lineNumber, lineNumber, ownerId, filterOutValidation);
	}

	/**
	 * Fetch only multi-line decorations that intersect with the given line number range
	 */
	private _getMultiLineDecorations(filterRange: Range, filterOwnerId: number, filterOutValidation: boolean): InternalDecoration[] {
		const filterStartLineNumber = filterRange.startLineNumber;
		const filterStartColumn = filterRange.startColumn;
		const filterEndLineNumber = filterRange.endLineNumber;
		const filterEndColumn = filterRange.endColumn;

		let result: InternalDecoration[] = [];

		for (let decorationId in this._multiLineDecorationsMap) {
			// No `hasOwnProperty` call due to using Object.create(null)
			let decoration = this._multiLineDecorationsMap[decorationId];

			if (filterOwnerId && decoration.ownerId && decoration.ownerId !== filterOwnerId) {
				continue;
			}

			if (filterOutValidation && decoration.isForValidation) {
				continue;
			}

			let range = decoration.range;

			if (range.startLineNumber > filterEndLineNumber) {
				continue;
			}
			if (range.startLineNumber === filterEndLineNumber && range.startColumn > filterEndColumn) {
				continue;
			}
			if (range.endLineNumber < filterStartLineNumber) {
				continue;
			}
			if (range.endLineNumber === filterStartLineNumber && range.endColumn < filterStartColumn) {
				continue;
			}

			result.push(decoration);
		}

		return result;
	}

	private _getDecorationsInRange(filterRange: Range, filterOwnerId: number, filterOutValidation: boolean): InternalDecoration[] {
		const filterStartLineNumber = filterRange.startLineNumber;
		const filterStartColumn = filterRange.startColumn;
		const filterEndLineNumber = filterRange.endLineNumber;
		const filterEndColumn = filterRange.endColumn;

		let result = this._getMultiLineDecorations(filterRange, filterOwnerId, filterOutValidation);
		let resultMap: { [decorationId: string]: boolean; } = {};

		for (let i = 0, len = result.length; i < len; i++) {
			resultMap[result[i].id] = true;
		}

		for (let lineNumber = filterStartLineNumber; lineNumber <= filterEndLineNumber; lineNumber++) {
			let lineMarkers = this._lines[lineNumber - 1].getMarkers();
			if (lineMarkers === null) {
				continue;
			}
			for (let i = 0, len = lineMarkers.length; i < len; i++) {
				let lineMarker = lineMarkers[i];
				let internalDecorationId = lineMarker.internalDecorationId;

				if (internalDecorationId === 0) {
					// marker does not belong to any decoration
					continue;
				}

				let decoration = this._internalDecorations[internalDecorationId];

				if (resultMap.hasOwnProperty(decoration.id)) {
					// decoration already in result
					continue;
				}

				if (filterOwnerId && decoration.ownerId && decoration.ownerId !== filterOwnerId) {
					continue;
				}

				if (filterOutValidation && decoration.isForValidation) {
					continue;
				}

				let range = decoration.range;

				if (range.startLineNumber > filterEndLineNumber) {
					continue;
				}
				if (range.startLineNumber === filterEndLineNumber && range.startColumn > filterEndColumn) {
					continue;
				}
				if (range.endLineNumber < filterStartLineNumber) {
					continue;
				}
				if (range.endLineNumber === filterStartLineNumber && range.endColumn < filterStartColumn) {
					continue;
				}

				result.push(decoration);
				resultMap[decoration.id] = true;
			}
		}

		return result;
	}

	public getLinesDecorations(_startLineNumber: number, _endLineNumber: number, ownerId: number = 0, filterOutValidation: boolean = false): editorCommon.IModelDecoration[] {
		let lineCount = this.getLineCount();
		let startLineNumber = Math.min(lineCount, Math.max(1, _startLineNumber));
		let endLineNumber = Math.min(lineCount, Math.max(1, _endLineNumber));
		let endColumn = this.getLineMaxColumn(endLineNumber);
		return this._getDecorationsInRange(new Range(startLineNumber, 1, endLineNumber, endColumn), ownerId, filterOutValidation);
	}

	public getDecorationsInRange(range: IRange, ownerId?: number, filterOutValidation?: boolean): editorCommon.IModelDecoration[] {
		let validatedRange = this.validateRange(range);
		return this._getDecorationsInRange(validatedRange, ownerId, filterOutValidation);
	}

	public getAllDecorations(ownerId: number = 0, filterOutValidation: boolean = false): editorCommon.IModelDecoration[] {
		let result: InternalDecoration[] = [];

		for (let decorationId in this._decorations) {
			// No `hasOwnProperty` call due to using Object.create(null)
			let decoration = this._decorations[decorationId];

			if (ownerId && decoration.ownerId && decoration.ownerId !== ownerId) {
				continue;
			}

			if (filterOutValidation && decoration.isForValidation) {
				continue;
			}

			result.push(decoration);
		}

		return result;
	}

	protected _acquireMarkersTracker(): MarkersTracker {
		if (this._currentMarkersTrackerCnt === 0) {
			this._currentMarkersTracker = new MarkersTracker();
		}
		this._currentMarkersTrackerCnt++;
		return this._currentMarkersTracker;
	}

	protected _releaseMarkersTracker(): void {
		this._currentMarkersTrackerCnt--;
		if (this._currentMarkersTrackerCnt === 0) {
			let markersTracker = this._currentMarkersTracker;
			this._currentMarkersTracker = null;
			this._handleTrackedMarkers(markersTracker);
		}
	}

	/**
	 * Handle changed markers (i.e. update decorations ranges and return the changed decorations, unique and sorted by id)
	 */
	private _handleTrackedMarkers(markersTracker: MarkersTracker): void {
		let changedInternalDecorationIds = markersTracker.getDecorationIds();
		if (changedInternalDecorationIds.length === 0) {
			return;
		}

		changedInternalDecorationIds.sort();

		let uniqueChangedDecorations: string[] = [], uniqueChangedDecorationsLen = 0;
		let previousInternalDecorationId: number = 0;
		for (let i = 0, len = changedInternalDecorationIds.length; i < len; i++) {
			let internalDecorationId = changedInternalDecorationIds[i];
			if (internalDecorationId === previousInternalDecorationId) {
				continue;
			}
			previousInternalDecorationId = internalDecorationId;

			let decoration = this._internalDecorations[internalDecorationId];
			if (!decoration) {
				// perhaps the decoration was removed in the meantime
				continue;
			}

			let startMarker = decoration.startMarker.position;
			let endMarker = decoration.endMarker.position;
			let range = TextModelWithDecorations._createRangeFromMarkers(startMarker, endMarker);
			decoration.setRange(this._multiLineDecorationsMap, range);

			uniqueChangedDecorations[uniqueChangedDecorationsLen++] = decoration.id;
		}

		if (uniqueChangedDecorations.length > 0) {
			let e: textModelEvents.IModelDecorationsChangedEvent = {
				addedDecorations: [],
				changedDecorations: uniqueChangedDecorations,
				removedDecorations: []
			};
			this.emitModelDecorationsChangedEvent(e);
		}
	}

	private static _createRangeFromMarkers(startPosition: Position, endPosition: Position): Range {
		if (endPosition.isBefore(startPosition)) {
			// This tracked range has turned in on itself (end marker before start marker)
			// This can happen in extreme editing conditions where lots of text is removed and lots is added

			// Treat it as a collapsed range
			return new Range(startPosition.lineNumber, startPosition.column, startPosition.lineNumber, startPosition.column);
		}
		return new Range(startPosition.lineNumber, startPosition.column, endPosition.lineNumber, endPosition.column);
	}

	private _acquireDecorationsTracker(): DecorationsTracker {
		if (this._currentDecorationsTrackerCnt === 0) {
			this._currentDecorationsTracker = new DecorationsTracker();
		}
		this._currentDecorationsTrackerCnt++;
		return this._currentDecorationsTracker;
	}

	private _releaseDecorationsTracker(): void {
		this._currentDecorationsTrackerCnt--;
		if (this._currentDecorationsTrackerCnt === 0) {
			let decorationsTracker = this._currentDecorationsTracker;
			this._currentDecorationsTracker = null;
			this._handleTrackedDecorations(decorationsTracker);
		}
	}

	private _handleTrackedDecorations(decorationsTracker: DecorationsTracker): void {
		if (
			decorationsTracker.addedDecorationsLen === 0
			&& decorationsTracker.changedDecorationsLen === 0
			&& decorationsTracker.removedDecorationsLen === 0
		) {
			return;
		}

		let e: textModelEvents.IModelDecorationsChangedEvent = {
			addedDecorations: decorationsTracker.addedDecorations,
			changedDecorations: decorationsTracker.changedDecorations,
			removedDecorations: decorationsTracker.removedDecorations
		};
		this.emitModelDecorationsChangedEvent(e);
	}

	private emitModelDecorationsChangedEvent(e: textModelEvents.IModelDecorationsChangedEvent): void {
		if (!this._isDisposing) {
			this._eventEmitter.emit(textModelEvents.TextModelEventType.ModelDecorationsChanged, e);
		}
	}

	private _normalizeDeltaDecorations(deltaDecorations: editorCommon.IModelDeltaDecoration[]): ModelDeltaDecoration[] {
		let result: ModelDeltaDecoration[] = [];
		for (let i = 0, len = deltaDecorations.length; i < len; i++) {
			let deltaDecoration = deltaDecorations[i];
			result.push(new ModelDeltaDecoration(i, this.validateRange(deltaDecoration.range), _normalizeOptions(deltaDecoration.options)));
		}
		return result;
	}

	private _externalDecorationId(internalId: number): string {
		return `${this._instanceId};${internalId}`;
	}

	private _addDecorationImpl(decorationsTracker: DecorationsTracker, ownerId: number, _range: Range, options: ModelDecorationOptions): string {
		let range = this.validateRange(_range);

		let internalDecorationId = (++this._lastDecorationId);
		let decorationId = this._externalDecorationId(internalDecorationId);

		let markers = this._addMarkers([
			{
				internalDecorationId: internalDecorationId,
				position: new Position(range.startLineNumber, range.startColumn),
				stickToPreviousCharacter: TextModelWithDecorations._shouldStartMarkerSticksToPreviousCharacter(options.stickiness)
			},
			{
				internalDecorationId: internalDecorationId,
				position: new Position(range.endLineNumber, range.endColumn),
				stickToPreviousCharacter: TextModelWithDecorations._shouldEndMarkerSticksToPreviousCharacter(options.stickiness)
			}
		]);

		let decoration = new InternalDecoration(decorationId, internalDecorationId, ownerId, range, markers[0], markers[1], options);
		this._decorations[decorationId] = decoration;
		this._internalDecorations[internalDecorationId] = decoration;
		if (range.startLineNumber !== range.endLineNumber) {
			this._multiLineDecorationsMap[decorationId] = decoration;
		}

		decorationsTracker.addNewDecoration(decorationId);

		return decorationId;
	}

	private _addDecorationsImpl(decorationsTracker: DecorationsTracker, ownerId: number, newDecorations: ModelDeltaDecoration[]): string[] {
		let internalDecorationIds: number[] = [];
		let decorationIds: string[] = [];
		let newMarkers: INewMarker[] = [];

		for (let i = 0, len = newDecorations.length; i < len; i++) {
			let newDecoration = newDecorations[i];
			let range = newDecoration.range;
			let stickiness = newDecoration.options.stickiness;

			let internalDecorationId = (++this._lastDecorationId);
			let decorationId = this._externalDecorationId(internalDecorationId);

			internalDecorationIds[i] = internalDecorationId;
			decorationIds[i] = decorationId;

			newMarkers[2 * i] = {
				internalDecorationId: internalDecorationId,
				position: new Position(range.startLineNumber, range.startColumn),
				stickToPreviousCharacter: TextModelWithDecorations._shouldStartMarkerSticksToPreviousCharacter(stickiness)
			};

			newMarkers[2 * i + 1] = {
				internalDecorationId: internalDecorationId,
				position: new Position(range.endLineNumber, range.endColumn),
				stickToPreviousCharacter: TextModelWithDecorations._shouldEndMarkerSticksToPreviousCharacter(stickiness)
			};
		}

		let markerIds = this._addMarkers(newMarkers);

		for (let i = 0, len = newDecorations.length; i < len; i++) {
			let newDecoration = newDecorations[i];
			let range = newDecoration.range;
			let internalDecorationId = internalDecorationIds[i];
			let decorationId = decorationIds[i];
			let startMarker = markerIds[2 * i];
			let endMarker = markerIds[2 * i + 1];

			let decoration = new InternalDecoration(decorationId, internalDecorationId, ownerId, range, startMarker, endMarker, newDecoration.options);
			this._decorations[decorationId] = decoration;
			this._internalDecorations[internalDecorationId] = decoration;
			if (range.startLineNumber !== range.endLineNumber) {
				this._multiLineDecorationsMap[decorationId] = decoration;
			}

			decorationsTracker.addNewDecoration(decorationId);
		}

		return decorationIds;
	}

	private _changeDecorationImpl(decorationsTracker: DecorationsTracker, decorationId: string, newRange: Range): void {
		let decoration = this._decorations[decorationId];
		if (!decoration) {
			return;
		}

		let startMarker = decoration.startMarker;
		if (newRange.startLineNumber !== startMarker.position.lineNumber) {
			// move marker between lines
			this._lines[startMarker.position.lineNumber - 1].removeMarker(startMarker);
			this._lines[newRange.startLineNumber - 1].addMarker(startMarker);
		}
		startMarker.setPosition(new Position(newRange.startLineNumber, newRange.startColumn));

		let endMarker = decoration.endMarker;
		if (newRange.endLineNumber !== endMarker.position.lineNumber) {
			// move marker between lines
			this._lines[endMarker.position.lineNumber - 1].removeMarker(endMarker);
			this._lines[newRange.endLineNumber - 1].addMarker(endMarker);
		}
		endMarker.setPosition(new Position(newRange.endLineNumber, newRange.endColumn));

		decoration.setRange(this._multiLineDecorationsMap, newRange);

		decorationsTracker.addMovedDecoration(decorationId);
	}

	private _changeDecorationOptionsImpl(decorationsTracker: DecorationsTracker, decorationId: string, options: ModelDecorationOptions): void {
		let decoration = this._decorations[decorationId];
		if (!decoration) {
			return;
		}

		if (decoration.options.stickiness !== options.stickiness) {
			decoration.startMarker.stickToPreviousCharacter = TextModelWithDecorations._shouldStartMarkerSticksToPreviousCharacter(options.stickiness);
			decoration.endMarker.stickToPreviousCharacter = TextModelWithDecorations._shouldEndMarkerSticksToPreviousCharacter(options.stickiness);
		}

		decoration.setOptions(options);

		decorationsTracker.addUpdatedDecoration(decorationId);
	}

	private _removeDecorationImpl(decorationsTracker: DecorationsTracker, decorationId: string): void {
		let decoration = this._decorations[decorationId];
		if (!decoration) {
			return;
		}

		this._removeMarkers([decoration.startMarker, decoration.endMarker]);

		delete this._multiLineDecorationsMap[decorationId];
		delete this._decorations[decorationId];
		delete this._internalDecorations[decoration.internalId];

		if (decorationsTracker) {
			decorationsTracker.addRemovedDecoration(decorationId);
		}
	}

	private _removeDecorationsImpl(decorationsTracker: DecorationsTracker, decorationIds: string[]): void {
		let removeMarkers: LineMarker[] = [], removeMarkersLen = 0;

		for (let i = 0, len = decorationIds.length; i < len; i++) {
			let decorationId = decorationIds[i];
			let decoration = this._decorations[decorationId];
			if (!decoration) {
				continue;
			}

			if (decorationsTracker) {
				decorationsTracker.addRemovedDecoration(decorationId);
			}

			removeMarkers[removeMarkersLen++] = decoration.startMarker;
			removeMarkers[removeMarkersLen++] = decoration.endMarker;
			delete this._multiLineDecorationsMap[decorationId];
			delete this._decorations[decorationId];
			delete this._internalDecorations[decoration.internalId];
		}

		if (removeMarkers.length > 0) {
			this._removeMarkers(removeMarkers);
		}
	}

	private _resolveOldDecorations(oldDecorations: string[]): InternalDecoration[] {
		let result: InternalDecoration[] = [];
		for (let i = 0, len = oldDecorations.length; i < len; i++) {
			let id = oldDecorations[i];
			let decoration = this._decorations[id];
			if (!decoration) {
				continue;
			}

			result.push(decoration);
		}
		return result;
	}

	private _deltaDecorationsImpl(decorationsTracker: DecorationsTracker, ownerId: number, oldDecorationsIds: string[], newDecorations: ModelDeltaDecoration[]): string[] {

		if (oldDecorationsIds.length === 0) {
			// Nothing to remove
			return this._addDecorationsImpl(decorationsTracker, ownerId, newDecorations);
		}

		if (newDecorations.length === 0) {
			// Nothing to add
			this._removeDecorationsImpl(decorationsTracker, oldDecorationsIds);
			return [];
		}

		let oldDecorations = this._resolveOldDecorations(oldDecorationsIds);

		oldDecorations.sort((a, b) => Range.compareRangesUsingStarts(a.range, b.range));
		newDecorations.sort((a, b) => Range.compareRangesUsingStarts(a.range, b.range));

		let result: string[] = [],
			oldDecorationsIndex = 0,
			oldDecorationsLength = oldDecorations.length,
			newDecorationsIndex = 0,
			newDecorationsLength = newDecorations.length,
			decorationsToAdd: ModelDeltaDecoration[] = [],
			decorationsToRemove: string[] = [];

		while (oldDecorationsIndex < oldDecorationsLength && newDecorationsIndex < newDecorationsLength) {
			let oldDecoration = oldDecorations[oldDecorationsIndex];
			let newDecoration = newDecorations[newDecorationsIndex];
			let comparison = Range.compareRangesUsingStarts(oldDecoration.range, newDecoration.range);

			if (comparison < 0) {
				// `oldDecoration` is before `newDecoration` => remove `oldDecoration`
				decorationsToRemove.push(oldDecoration.id);
				oldDecorationsIndex++;
				continue;
			}

			if (comparison > 0) {
				// `newDecoration` is before `oldDecoration` => add `newDecoration`
				decorationsToAdd.push(newDecoration);
				newDecorationsIndex++;
				continue;
			}

			// The ranges of `oldDecoration` and `newDecoration` are equal

			if (!oldDecoration.options.equals(newDecoration.options)) {
				// The options do not match => remove `oldDecoration`
				decorationsToRemove.push(oldDecoration.id);
				oldDecorationsIndex++;
				continue;
			}

			// Bingo! We can reuse `oldDecoration` for `newDecoration`
			result[newDecoration.index] = oldDecoration.id;
			oldDecorationsIndex++;
			newDecorationsIndex++;
		}

		while (oldDecorationsIndex < oldDecorationsLength) {
			// No more new decorations => remove decoration at `oldDecorationsIndex`
			decorationsToRemove.push(oldDecorations[oldDecorationsIndex].id);
			oldDecorationsIndex++;
		}

		while (newDecorationsIndex < newDecorationsLength) {
			// No more old decorations => add decoration at `newDecorationsIndex`
			decorationsToAdd.push(newDecorations[newDecorationsIndex]);
			newDecorationsIndex++;
		}

		// Remove `decorationsToRemove`
		if (decorationsToRemove.length > 0) {
			this._removeDecorationsImpl(decorationsTracker, decorationsToRemove);
		}

		// Add `decorationsToAdd`
		if (decorationsToAdd.length > 0) {
			let newIds = this._addDecorationsImpl(decorationsTracker, ownerId, decorationsToAdd);
			for (let i = 0, len = decorationsToAdd.length; i < len; i++) {
				result[decorationsToAdd[i].index] = newIds[i];
			}
		}

		return result;
	}
}

function cleanClassName(className: string): string {
	return className.replace(/[^a-z0-9\-]/gi, ' ');
}

export class ModelDecorationOptions implements editorCommon.IModelDecorationOptions {

	stickiness: editorCommon.TrackedRangeStickiness;
	className: string;
	hoverMessage: MarkedString | MarkedString[];
	glyphMarginHoverMessage: MarkedString | MarkedString[];
	isWholeLine: boolean;
	showInOverviewRuler: string;
	overviewRuler: editorCommon.IModelDecorationOverviewRulerOptions;
	glyphMarginClassName: string;
	linesDecorationsClassName: string;
	marginClassName: string;
	inlineClassName: string;
	beforeContentClassName: string;
	afterContentClassName: string;

	constructor(options: editorCommon.IModelDecorationOptions) {
		this.stickiness = options.stickiness || editorCommon.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges;
		this.className = options.className ? cleanClassName(options.className) : strings.empty;
		this.hoverMessage = options.hoverMessage || [];
		this.glyphMarginHoverMessage = options.glyphMarginHoverMessage || strings.empty;
		this.isWholeLine = options.isWholeLine || false;
		this.overviewRuler = _normalizeOverviewRulerOptions(options.overviewRuler, options.showInOverviewRuler);
		this.glyphMarginClassName = options.glyphMarginClassName ? cleanClassName(options.glyphMarginClassName) : strings.empty;
		this.linesDecorationsClassName = options.linesDecorationsClassName ? cleanClassName(options.linesDecorationsClassName) : strings.empty;
		this.marginClassName = options.marginClassName ? cleanClassName(options.marginClassName) : strings.empty;
		this.inlineClassName = options.inlineClassName ? cleanClassName(options.inlineClassName) : strings.empty;
		this.beforeContentClassName = options.beforeContentClassName ? cleanClassName(options.beforeContentClassName) : strings.empty;
		this.afterContentClassName = options.afterContentClassName ? cleanClassName(options.afterContentClassName) : strings.empty;
	}

	private static _overviewRulerEquals(a: editorCommon.IModelDecorationOverviewRulerOptions, b: editorCommon.IModelDecorationOverviewRulerOptions): boolean {
		return (
			a.color === b.color
			&& a.position === b.position
			&& a.darkColor === b.darkColor
		);
	}

	public equals(other: ModelDecorationOptions): boolean {
		return (
			this.stickiness === other.stickiness
			&& this.className === other.className
			&& this.isWholeLine === other.isWholeLine
			&& this.showInOverviewRuler === other.showInOverviewRuler
			&& this.glyphMarginClassName === other.glyphMarginClassName
			&& this.linesDecorationsClassName === other.linesDecorationsClassName
			&& this.marginClassName === other.marginClassName
			&& this.inlineClassName === other.inlineClassName
			&& this.beforeContentClassName === other.beforeContentClassName
			&& this.afterContentClassName === other.afterContentClassName
			&& markedStringsEquals(this.hoverMessage, other.hoverMessage)
			&& markedStringsEquals(this.glyphMarginHoverMessage, other.glyphMarginHoverMessage)
			&& ModelDecorationOptions._overviewRulerEquals(this.overviewRuler, other.overviewRuler)
		);
	}
}

class ModelDeltaDecoration implements editorCommon.IModelDeltaDecoration {

	index: number;
	range: Range;
	options: ModelDecorationOptions;

	constructor(index: number, range: Range, options: ModelDecorationOptions) {
		this.index = index;
		this.range = range;
		this.options = options;
	}
}

function _normalizeOptions(options: editorCommon.IModelDecorationOptions): ModelDecorationOptions {
	return new ModelDecorationOptions(options);
}

class ModelDecorationOverviewRulerOptions implements editorCommon.IModelDecorationOverviewRulerOptions {
	color: string;
	darkColor: string;
	hcColor: string;
	position: editorCommon.OverviewRulerLane;

	constructor(options: editorCommon.IModelDecorationOverviewRulerOptions, legacyShowInOverviewRuler: string) {
		this.color = strings.empty;
		this.darkColor = strings.empty;
		this.hcColor = strings.empty;
		this.position = editorCommon.OverviewRulerLane.Center;

		if (legacyShowInOverviewRuler) {
			this.color = legacyShowInOverviewRuler;
		}
		if (options && options.color) {
			this.color = options.color;
		}
		if (options && options.darkColor) {
			this.darkColor = options.darkColor;
			this.hcColor = options.darkColor;
		}
		if (options && options.hcColor) {
			this.hcColor = options.hcColor;
		}
		if (options && options.hasOwnProperty('position')) {
			this.position = options.position;
		}
	}
}

function _normalizeOverviewRulerOptions(options: editorCommon.IModelDecorationOverviewRulerOptions, legacyShowInOverviewRuler: string = null): editorCommon.IModelDecorationOverviewRulerOptions {
	return new ModelDecorationOverviewRulerOptions(options, legacyShowInOverviewRuler);
}
