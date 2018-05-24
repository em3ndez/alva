import * as Sender from '../message/client';
import { ServerMessageType } from '../message';
import * as Mobx from 'mobx';
import * as Model from '../model';
import * as Types from '../model/types';

import * as uuid from 'uuid';

export enum ClipBoardType {
	Page = 'Page',
	Element = 'Element'
}

export type ClipBoardItem = ClipboardPage | ClipboardElement;

export interface ClipboardPage {
	item: Model.Page;
	type: ClipBoardType.Page;
}

export interface ClipboardElement {
	item: Model.Element;
	type: ClipBoardType.Element;
}

/**
 * The central entry-point for all view-related application state, managed by MobX.
 * Use this object and its properties in your React components,
 * and call the respective business methods to perform operations.
 */
export class ViewStore {
	/**
	 * The store singleton instance.
	 */
	private static INSTANCE: ViewStore;

	/**
	 * The page that is currently being displayed in the preview, and edited in the elements
	 * and properties panes. May be undefined if there is none.
	 */
	@Mobx.observable private activePage?: number = 0;

	/**
	 * The current state of the Page Overview
	 */
	@Mobx.observable private activeView: Types.AlvaView = Types.AlvaView.SplashScreen;

	/**
	 * The name of the analyzer that should be used for the open styleguide.
	 */
	@Mobx.observable private analyzerName: string;

	@Mobx.observable private appState: Types.AppState = Types.AppState.Starting;

	/**
	 * The element currently in the clipboard, or undefined if there is none.
	 * Note: The element is cloned lazily, so it may represent a still active element.
	 * When adding the clipboard element to paste it, clone it first.
	 */
	@Mobx.observable private clipboardItem?: ClipBoardItem;

	@Mobx.observable private highlightedElement?: Model.Element;

	@Mobx.observable private highlightedPlaceholderElement?: Model.Element;

	/**
	 * The currently name-editable element in the element list.
	 */
	@Mobx.observable private nameEditableElement?: Model.Element;

	/**
	 * The current search term in the patterns list, or an empty string if there is none.
	 */
	@Mobx.observable private patternSearchTerm: string = '';

	@Mobx.observable private project: Model.Project;

	/**
	 * The most recent undone user commands (user operations) to provide a redo feature.
	 * Note that operations that close or open a page clear this buffer.
	 * The last command in the list is the most recent undone.
	 */
	@Mobx.observable private redoBuffer: Model.Command[] = [];

	/**
	 * The well-known enum name of content that should be visible in
	 * the right-hand sidebar/pane.
	 */
	@Mobx.observable private rightPane: Types.RightPane | null = null;

	/**
	 * The currently selected element in the element list.
	 * The properties pane shows the properties of this element,
	 * and keyboard commands like cut, copy, or delete operate on this element.
	 * May be empty if no element is selected.
	 * @see isElementFocussed
	 */
	@Mobx.observable private selectedElement?: Model.Element;

	/**
	 * http port the preview server is listening on
	 */
	@Mobx.observable private serverPort: number;

	/**
	 * The most recent user commands (user operations) to provide an undo feature.
	 * Note that operations that close or open a page clear this buffer.
	 * The last command in the list is the most recent executed one.
	 */
	@Mobx.observable private undoBuffer: Model.Command[] = [];

	/**
	 * Creates a new store.
	 */
	private constructor() {}

	/**
	 * Returns (or creates) the one global store instance.
	 * @return The one global store instance.
	 */
	public static getInstance(): ViewStore {
		if (!ViewStore.INSTANCE) {
			ViewStore.INSTANCE = new ViewStore();
			// tslint:disable-next-line:no-any
			(global as any).viewStore = ViewStore.INSTANCE;
		}

		return ViewStore.INSTANCE;
	}

	public addNewElement(init: { pattern: Model.Pattern }): Model.Element | undefined {
		const project = this.getProject();
		const patternLibrary = project.getPatternLibrary();

		const elementContents = init.pattern.getSlots().map(
			slot =>
				new Model.ElementContent(
					{
						elementIds: [],
						id: uuid.v4(),
						name: slot.getName(),
						slotId: slot.getId()
					},
					{ project, patternLibrary }
				)
		);

		const element = new Model.Element(
			{
				contentIds: elementContents.map(e => e.getId()),
				open: false,
				patternId: init.pattern.getId(),
				properties: [],
				setDefaults: true
			},
			{
				patternLibrary,
				project
			}
		);

		elementContents.forEach(elementContent => {
			elementContent.setParentElement(element);
			project.addElementContent(elementContent);
		});

		project.addElement(element);

		return element;
	}

	public addNewPage(): Model.Page | undefined {
		const patternLibrary = this.project.getPatternLibrary();
		const name = 'Untitled Page';

		const count = this.project.getPages().filter(p => p.getName().startsWith(name)).length;

		const page = Model.Page.create(
			{
				id: uuid.v4(),
				name: `${name} ${count + 1}`,
				patternLibrary: this.project.getPatternLibrary()
			},
			{ project: this.project, patternLibrary }
		);

		this.execute(Model.PageAddCommand.create({ page, project: this.project }));
		return page;
	}

	/**
	 * Clears the undo and redo buffers (e.g. if a page is loaded or the page state get
	 * incompatible with the buffers).
	 */
	public clearUndoRedoBuffers(): void {
		this.undoBuffer = [];
		this.redoBuffer = [];
	}

	public connectPatternLibrary(): void {
		const project = this.project;

		if (!project) {
			return;
		}

		Sender.send({
			type: ServerMessageType.ConnectPatternLibraryRequest,
			id: uuid.v4(),
			payload: project.toJSON()
		});
	}

	public copyElementById(id: string): Model.Element | undefined {
		const element = this.getElementById(id);

		if (!element) {
			return;
		}

		this.setClipboardItem(element);
		return element;
	}

	/**
	 * Copy the currently selected element to clip
	 */
	public copySelectedElement(): Model.Element | undefined {
		if (!this.selectedElement) {
			return;
		}

		const element = this.selectedElement;
		this.setClipboardItem(element);
		return element;
	}

	/**
	 * Remove the given element from its page and add it to clipboard
	 * @param element
	 */
	public cutElement(element: Model.Element): void {
		if (element.isRoot()) {
			return;
		}

		this.setClipboardItem(element);
		this.execute(new Model.ElementRemoveCommand({ element }));
	}

	public cutElementById(id: string): void {
		const element = this.getElementById(id);
		if (!element) {
			return;
		}

		this.cutElement(element);
	}

	public cutSelectedElement(): Model.Element | undefined {
		if (!this.selectedElement) {
			return;
		}

		const element = this.selectedElement;
		this.cutElement(element);
		return element;
	}

	public duplicateElement(element: Model.Element): Model.Element | undefined {
		const clone = this.insertAfterElement({ element: element.clone(), targetElement: element });

		if (!clone) {
			return;
		}

		this.setSelectedElement(clone);
		return clone;
	}

	public duplicateElementById(id: string): Model.Element | undefined {
		const element = this.getElementById(id);

		if (!element) {
			return;
		}

		return this.duplicateElement(element);
	}

	public duplicateSelectedElement(): Model.Element | undefined {
		if (!this.selectedElement) {
			return;
		}
		return this.duplicateElement(this.selectedElement);
	}

	/**
	 * Executes a user command (user operation) and registers it as undoable command.
	 * @param command The command to execute and register.
	 */
	public execute(command: Model.Command): void {
		const successful: boolean = command.execute();
		if (!successful) {
			// The state and the undo/redo buffers are out of sync.
			// This may be the case if not all store operations are proper command implementations.
			// In that case, the store is correct and we drop the undo/redo buffers.
			this.clearUndoRedoBuffers();
			return;
		}

		// The command was processed successfully, now memorize it to provide an undo stack.

		// But first, we give the command the chance to indicate that the previous undo command
		// and the current one are too similar to keep both. If so, the newer command
		// incorporates both commands' changes into itself, and we keep only that newer one
		// on the undo stack.

		const previousCommand = this.undoBuffer[this.undoBuffer.length - 1];
		const wasMerged = previousCommand && command.maybeMergeWith(previousCommand);
		if (wasMerged) {
			// The newer command now contains both changes, so we drop the previous one
			this.undoBuffer.pop();
		}

		// Now memorize the new command
		this.undoBuffer.push(command);

		// All previously undone commands (the redo stack) are invalid after a forward command
		this.redoBuffer = [];
	}

	public getActiveView(): Types.AlvaView {
		return this.activeView;
	}

	/**
	 * Returns the name of the analyzer that should be used for the open styleguide.
	 * @return The name of the analyzer that should be used for the open styleguide.
	 */
	public getAnalyzerName(): string {
		return this.analyzerName;
	}

	public getAppState(): Types.AppState {
		return this.appState;
	}

	public getClipboardItem(type: ClipBoardType.Element): Model.Element | undefined;
	public getClipboardItem(type: ClipBoardType.Page): Model.Page | undefined;
	public getClipboardItem(type: ClipBoardType): Model.Page | Model.Element | undefined {
		const item = this.clipboardItem;

		if (!item || item.type !== type) {
			return;
		}

		return item.item.clone();
	}

	public getContentById(id: string): Model.ElementContent | undefined {
		const project = this.getProject();

		let result;

		project.getPages().some(page => {
			result = page.getContentById(id);
			return result;
		});

		return result;
	}

	/**
	 * Returns the page content that is currently being displayed in the preview,
	 * and edited in the elements and properties panes. May be undefined if there is none.
	 * @return The page content that is currently being displayed in the preview, or undefined.
	 */
	public getCurrentPage(): Model.Page | undefined {
		if (!this.project) {
			return;
		}

		if (typeof this.activePage === 'undefined') {
			return;
		}

		const pages = this.project.getPages();

		if (pages.length === 0) {
			return;
		}

		if (pages.length - 1 < this.activePage) {
			return;
		}

		return this.project.getPages()[this.activePage];
	}

	public getElementById(id: string): Model.Element | undefined {
		const project = this.getProject();

		let result;

		project.getPages().some(page => {
			result = page.getElementById(id);
			return result;
		});

		return result;
	}

	public getHighlightedElement(): Model.Element | undefined {
		return this.highlightedElement;
	}

	public getHighlightedPlaceholderElement(): Model.Element | undefined {
		return this.highlightedPlaceholderElement;
	}

	public getNameEditableElement(): Model.Element | undefined {
		return this.nameEditableElement;
	}

	public getPageById(id: string): Model.Page | undefined {
		const project = this.getProject();

		if (!project) {
			return;
		}

		return project.getPageById(id);
	}

	public getPatternById(id: string): Model.Pattern | undefined {
		const project = this.getProject();

		if (!project) {
			return;
		}

		const patternLibrary = project.getPatternLibrary();

		if (!patternLibrary) {
			return;
		}

		return patternLibrary.getPatternById(id);
	}

	public getPatternLibrary(): Model.PatternLibrary | undefined {
		const project = this.getProject();

		if (!project) {
			return;
		}

		return project.getPatternLibrary();
	}

	public getPatternLibraryState(): Types.PatternLibraryState | undefined {
		const patternLibrary = this.getPatternLibrary();

		if (!patternLibrary) {
			return;
		}

		return patternLibrary.getState();
	}

	public getPatternSearchTerm(): string {
		return this.patternSearchTerm;
	}

	public getProject(): Model.Project {
		return this.project;
	}

	/**
	 * @return The content id to show in the right-hand sidebar
	 */
	public getRightPane(): Types.RightPane {
		if (this.rightPane === null) {
			return this.selectedElement ? Types.RightPane.Properties : Types.RightPane.Patterns;
		}
		return this.rightPane;
	}

	public getSelectedElement(): Model.Element | undefined {
		return this.selectedElement;
	}

	public getServerPort(): number {
		return this.serverPort;
	}

	public hasApplicableClipboardItem(): boolean {
		const view = this.getActiveView();

		if (view === Types.AlvaView.PageDetail) {
			return Boolean(this.getClipboardItem(ClipBoardType.Element));
		}

		if (view === Types.AlvaView.Pages) {
			return Boolean(this.getClipboardItem(ClipBoardType.Page));
		}

		return false;
	}

	/**
	 * Returns whether there is a user comment (user operation) to redo.
	 * @return Whether there is a user comment (user operation) to redo.
	 * @see redo
	 */
	public hasRedoCommand(): boolean {
		return this.redoBuffer.length > 0;
	}

	/**
	 * Returns whether there is a user comment (user operation) to undo.
	 * @return Whether there is a user comment (user operation) to undo.
	 * @see undo
	 */
	public hasUndoCommand(): boolean {
		return this.undoBuffer.length > 0;
	}

	public insertAfterElement(init: {
		element: Model.Element;
		targetElement: Model.Element;
	}): Model.Element | undefined {
		if (init.targetElement.isRoot()) {
			return this.insertInsideElement(init);
		}

		const container = init.targetElement.getContainer();

		if (!container) {
			return;
		}

		this.execute(
			Model.ElementLocationCommand.addChild({
				index: init.targetElement.getIndex() + 1,
				contentId: container.getId(),
				childId: init.element.getId()
			})
		);

		this.setSelectedElement(init.element);
		return init.element;
	}

	public insertInsideElement(init: {
		element: Model.Element;
		targetElement: Model.Element;
	}): Model.Element | undefined {
		const contents = init.targetElement.getContentBySlotType(Types.SlotType.Children);

		if (!contents) {
			return;
		}

		this.execute(
			Model.ElementLocationCommand.addChild({
				contentId: contents.getId(),
				childId: init.element.getId(),
				index: contents.getElements().length
			})
		);

		this.setSelectedElement(init.element);

		return init.element;
	}

	public isElementHighlightedById(id: string): boolean {
		const highlightedElement = this.getHighlightedElement();

		if (highlightedElement) {
			return highlightedElement.getId() === id;
		}

		return false;
	}

	public isElementSelectedById(id: string): boolean {
		const selectedElement = this.getSelectedElement();

		if (selectedElement) {
			return selectedElement.getId() === id;
		}

		return false;
	}

	public isPlaceholderHiglightedById(id: string): boolean {
		const highlightedElement = this.getHighlightedPlaceholderElement();

		if (highlightedElement) {
			return highlightedElement.getId() === id;
		}

		return false;
	}

	public pasteAfterElement(targetElement: Model.Element): Model.Element | undefined {
		const clipboardElement = this.getClipboardItem(ClipBoardType.Element);

		if (!clipboardElement) {
			return;
		}

		return this.insertAfterElement({ element: clipboardElement, targetElement });
	}

	public pasteAfterElementById(id: string): Model.Element | undefined {
		const element = this.getElementById(id);

		if (!element) {
			return;
		}

		return this.pasteAfterElement(element);
	}

	public pasteAfterSelectedElement(): Model.Element | undefined {
		const selectedElement = this.getSelectedElement();
		const page = this.getCurrentPage();
		const rootElement = page ? page.getRoot() : undefined;

		if (!selectedElement && !rootElement) {
			return;
		}

		if (selectedElement) {
			return this.pasteAfterElement(selectedElement);
		}

		if (rootElement) {
			return this.pasteInsideElement(rootElement);
		}

		return;
	}

	public pasteInsideElement(element: Model.Element): Model.Element | undefined {
		const clipboardElement = this.getClipboardItem(ClipBoardType.Element);

		if (!clipboardElement) {
			return;
		}

		this.insertInsideElement({ element: clipboardElement, targetElement: element });

		return clipboardElement;
	}

	public pasteInsideElementById(id: string): Model.Element | undefined {
		const element = this.getElementById(id);

		if (!element) {
			return;
		}

		return this.pasteInsideElement(element);
	}

	public pasteInsideSelectedElement(): Model.Element | undefined {
		if (!this.selectedElement) {
			return;
		}

		return this.pasteInsideElement(this.selectedElement);
	}

	/**
	 * Redoes the last undone user operation, if available.
	 * @return Whether the redo was successful.
	 * @see hasRedoCommand
	 */
	public redo(): boolean {
		const command = this.redoBuffer.pop();
		if (!command) {
			return false;
		}

		const successful: boolean = command.execute();
		if (!successful) {
			// The state and the undo/redo buffers are out of sync.
			// This may be the case if not all store operations are proper command implementations.
			// In that case, the store is correct and we drop the undo/redo buffers.
			this.clearUndoRedoBuffers();
			return false;
		}

		this.undoBuffer.push(command);
		return true;
	}

	/**
	 * Removes the given element from its page
	 * @param element The Element to remove
	 */
	public removeElement(element: Model.Element): void {
		if (element.isRoot()) {
			return;
		}

		const index = element.getIndex();

		const getNextSelected = (): Model.Element | undefined => {
			if (typeof index !== 'number') {
				return;
			}

			const nextIndex = index > 0 ? Math.max(index - 1, 0) : 1;
			const container = element.getContainer();

			if (!container) {
				return;
			}

			return container.getElements()[nextIndex];
		};

		const elementBefore = getNextSelected();

		this.execute(new Model.ElementRemoveCommand({ element }));

		if (elementBefore) {
			this.setSelectedElement(elementBefore);
		} else {
			this.unsetSelectedElement();
		}
	}

	public removeElementById(id: string): void {
		const element = this.getElementById(id);

		if (element) {
			this.execute(new Model.ElementRemoveCommand({ element }));
		}
	}

	public removePage(page: Model.Page): void {
		const project = this.getProject();

		if (!project) {
			return;
		}

		this.execute(
			Model.PageRemoveCommand.create({
				page,
				project
			})
		);
	}

	/**
	 * Remove the currently selected element from its page
	 * Returns the deleted Element or undefined if nothing was deleted
	 */
	public removeSelectedElement(): Model.Element | undefined {
		if (!this.selectedElement) {
			return;
		}

		const element = this.selectedElement;
		this.removeElement(this.selectedElement);
		return element;
	}

	/**
	 * Remove the currently selected page from its project
	 * Returns the deleted PageRef or undefined if nothing was deleted
	 */
	public removeSelectedPage(): Model.Page | undefined {
		const page = this.getCurrentPage();

		if (!page) {
			return;
		}

		this.removePage(page);
		return page;
	}

	public setActivePage(page: Model.Page): boolean {
		if (!this.project) {
			return false;
		}

		const pages = this.project.getPages();
		const index = pages.indexOf(page);

		if (index === -1) {
			return false;
		}

		this.setActivePageByIndex(index);
		return true;
	}

	public setActivePageById(id: string): boolean {
		const page = this.getPageById(id);

		if (!this.project || !page) {
			return false;
		}

		return this.setActivePage(page);
	}

	public setActivePageByIndex(index: number): void {
		this.selectedElement = undefined;
		this.activePage = index;
	}

	public setActiveView(view: Types.AlvaView): void {
		this.activeView = view;
	}

	public setAppState(state: Types.AppState): void {
		this.appState = state;
	}

	/**
	 * Sets the element currently in the clipboard, or undefined if there is none.
	 * Note: The element is cloned lazily, so you don't need to clone it when setting.
	 * @see getClipboardElement
	 */
	public setClipboardItem(item: Model.Element | Model.Page): void {
		if (item instanceof Model.Element) {
			if (item.isRoot()) {
				return;
			}

			this.clipboardItem = {
				type: ClipBoardType.Element,
				item
			};
		}

		if (item instanceof Model.Page) {
			this.clipboardItem = {
				type: ClipBoardType.Page,
				item
			};
		}
	}

	public setHighlightedElementById(id: string): void {
		this.highlightedElement = this.getElementById(id);
	}

	public setHighlightedPlaceholderElementById(id: string): void {
		this.highlightedPlaceholderElement = this.getElementById(id);
	}

	public setNameEditableElement(editableElement?: Model.Element): void {
		if (this.nameEditableElement && this.nameEditableElement !== editableElement) {
			this.nameEditableElement.setNameEditable(false);
		}

		if (editableElement) {
			editableElement.setNameEditable(true);
		}

		this.nameEditableElement = editableElement;
	}

	/**
	 * Sets the current search term in the patterns list, or an empty string if there is none.
	 * @param patternSearchTerm The current pattern search term or an empty string.
	 */
	public setPatternSearchTerm(patternSearchTerm: string): void {
		this.patternSearchTerm = patternSearchTerm;
	}

	public setProject(project: Model.Project): void {
		this.project = project;
		const pages = this.project.getPages();

		if (pages.length > 0) {
			this.setActivePageByIndex(0);
		} else {
			this.unsetActivePage();
		}

		const patternLibrary = project.getPatternLibrary();

		if (patternLibrary) {
			patternLibrary.updateSearch();
		}
	}

	/**
	 * @return The content id to show in the right-hand sidebar
	 * @see rightPane
	 */
	public setRightPane(pane: Types.RightPane | null): void {
		this.rightPane = pane;
	}

	/**
	 * Sets the currently selected element in the element list.
	 * The properties pane shows the properties of this element,
	 * and keyboard commands like cut, copy, or delete operate on this element.
	 * May be empty if no element is selected.
	 * @param selectedElement The selected element or undefined.
	 * @see setElementFocussed
	 */
	public setSelectedElement(selectedElement: Model.Element): void {
		if (this.selectedElement && this.selectedElement !== selectedElement) {
			this.setNameEditableElement();
		}
		this.rightPane = null;
		this.selectedElement = selectedElement;
	}

	/**
	 * Set the port the preview server is listening to
	 * @param port
	 */
	public setServerPort(port: number): void {
		this.serverPort = port;
	}

	/**
	 * Undoes the last user operation, if available.
	 * @return Whether the undo was successful.
	 * @see hasUndoCommand
	 */
	public undo(): boolean {
		const command = this.undoBuffer.pop();
		if (!command) {
			return false;
		}

		const successful: boolean = command.undo();
		if (!successful) {
			// The state and the undo/redo buffers are out of sync.
			// This may be the case if not all store operations are proper command implementations.
			// In that case, the store is correct and we drop the undo/redo buffers.
			this.clearUndoRedoBuffers();
			return false;
		}

		this.redoBuffer.push(command);
		return true;
	}

	public unsetActivePage(): void {
		this.activePage = undefined;
	}

	public unsetHighlightedElementById(): void {
		this.highlightedElement = undefined;
	}

	public unsetHighlightedPlaceholderElementById(): void {
		this.highlightedPlaceholderElement = undefined;
	}

	public unsetSelectedElement(): void {
		this.selectedElement = undefined;
	}

	public updatePatternLibrary(): void {
		const project = this.project;

		if (!project) {
			return;
		}

		Sender.send({
			type: ServerMessageType.UpdatePatternLibraryRequest,
			id: uuid.v4(),
			payload: project.toJSON()
		});
	}
}