import classes from "./style.module.scss";
import { ActionIcon, Alert, Badge, Box, Button, Drawer, Group, Select, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { Icon } from "~/components/Icon";
import { CodeEditor } from "~/components/CodeEditor";
import { ModalTitle } from "~/components/ModalTitle";
import { Spacer } from "~/components/Spacer";
import { useInputState } from "@mantine/hooks";
import { useLayoutEffect, useState } from "react";
import { useStable } from "~/hooks/stable";
import { iconClose, iconPlus, iconWarning } from "~/util/icons";
import { RecordsChangedEvent } from "~/util/global-events";
import { useTableNames, useTables } from "~/hooks/schema";
import { executeQuery } from "~/screens/database/connection";
import { RecordId, StringRecordId, Table } from "surrealdb.js";
import { surqlLinting } from "~/util/editor/extensions";
import { surrealql } from "codemirror-surrealql";
import { useValueValidator } from "~/hooks/surrealql";
import { DrawerResizer } from "~/components/DrawerResizer";
import { Label } from "~/components/Label";
import { extractEdgeRecords } from "~/util/schema";
import { CodeInput } from "~/components/Inputs";
import { QueryResponse } from "~/types";
import { EditorView } from "@codemirror/view";

type EdgeInfo = [boolean, string[], string[]];

export interface CreatorDrawerProps {
	opened: boolean;
	table: string;
	onClose: () => void;
}

export function CreatorDrawer({ opened, table, onClose }: CreatorDrawerProps) {
	const [recordTable, setRecordTable] = useState('');
	const [recordId, setRecordId] = useInputState('');
	const [recordBody, setRecordBody] = useInputState('');
	const [recordFrom, setRecordFrom] = useInputState('');
	const [recordTo, setRecordTo] = useState('');
	const [isValid, body] = useValueValidator(recordBody);
	const [errors, setErrors] = useState<string[]>([]);
	const tables = useTableNames();

	const tableInfo = useTables().find((t) => t.schema.name === recordTable);

	const [isRelation, fromTables, toTables]: EdgeInfo = tableInfo
		? extractEdgeRecords(tableInfo)
		: [false, [], []];

	const handleSubmit = useStable(async () => {
		if (!isValid) {
			return;
		}

		const id = recordId
			? new RecordId(recordTable, recordId)
			: new Table(recordTable);

		let response: QueryResponse[];

		if (isRelation) {
			const from = new StringRecordId(recordFrom);
			const to = new StringRecordId(recordTo);

			const content = {
				...body,
				in: from,
				out: to
			};

			response = await executeQuery(/* surql */ `RELATE $from->$id->$to CONTENT $content`, { from, id, to, content });
		} else {
			response = await executeQuery(/* surql */ `CREATE $id CONTENT $body`, { id, body });
		}

		const errors = response.flatMap((r) => {
			if (r.success) return [];

			return [
				(r.result as string).replace('There was a problem with the database: ', '')
			];
		});

		setErrors(errors);

		if (errors.length === 0) {
			onClose();
			RecordsChangedEvent.dispatch(null);
		}
	});

	const setCursor = useStable((view: EditorView) => {
		view.dispatch({selection: {anchor: 6, head: 6}});
	});

	useLayoutEffect(() => {
		if (opened) {
			setErrors([]);
			setRecordTable(table);
			setRecordId('');
			setRecordBody('{\n    \n}');
			setRecordFrom('');
			setRecordTo('');
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [opened, table]);

	const isFullyValid = isValid && (!isRelation || recordFrom && recordTo);
	const [width, setWidth] = useState(650);

	return (
		<Drawer
			opened={opened}
			onClose={onClose}
			position="right"
			trapFocus={false}
			size={width}
			styles={{
				body: {
					height: "100%",
					maxHeight: "100%",
					display: "flex",
					flexWrap: "nowrap",
					flexDirection: "column",
					gap: "var(--mantine-spacing-lg)"
				}
			}}
		>
			<DrawerResizer
				minSize={500}
				maxSize={900}
				onResize={setWidth}
			/>

			<Group gap="sm">
				<ModalTitle>
					<Icon left path={iconPlus} size="sm" />
					Record creator
				</ModalTitle>

				<Spacer />

				{!isValid && (
					<Badge
						color="red"
						variant="light"
					>
						Invalid content
					</Badge>
				)}

				<ActionIcon
					onClick={onClose}
					aria-label="Close creator drawer"
				>
					<Icon path={iconClose} />
				</ActionIcon>
			</Group>

			<Stack
				flex={1}
				gap="md"
				style={{
					flexShrink: 1,
					flexBasis: 0
				}}
			>
				{errors.map((error, i) => (
					<Alert
						key={i}
						className={classes.error}
						icon={<Icon path={iconWarning} />}
						color="red.5"
						style={{
							whiteSpace: "pre-wrap"
						}}
					>
						{error}
					</Alert>
				))}

				<SimpleGrid cols={2}>
					<Select
						data={tables}
						label="Table"
						value={recordTable}
						onChange={setRecordTable as any}
					/>
					<TextInput
						label="Id"
						value={recordId}
						spellCheck={false}
						onChange={setRecordId}
						placeholder="Leave empty to generate"
					/>
				</SimpleGrid>

				{isRelation && (
					<SimpleGrid cols={2}>
						<CodeInput
							value={recordFrom}
							onChange={setRecordFrom}
							placeholder="table:id"
							label={
								<Box>
									<Text>From record</Text>
									{fromTables.length > 0 && (
										<Text c="slate">
											Valid tables: {fromTables.join(", ")}
										</Text>
									)}
								</Box>
							}
						/>
						<CodeInput
							value={recordTo}
							onChange={setRecordTo}
							placeholder="table:id"
							label={
								<Box>
									<Text>To record</Text>
									{toTables.length > 0 && (
										<Text c="slate">
											Valid tables: {toTables.join(", ")}
										</Text>
									)}
								</Box>
							}
						/>
					</SimpleGrid>
				)}

				<Box flex={1} pos="relative">
					<Label>Contents</Label>
					<CodeEditor
						pos="absolute"
						top={18}
						left={0}
						right={0}
						bottom={0}
						autoFocus
						value={recordBody}
						onChange={setRecordBody}
						extensions={[
							surrealql(),
							surqlLinting()
						]}
						onMount={setCursor}
					/>
				</Box>
			</Stack>

			<Button
				disabled={!isFullyValid}
				variant="gradient"
				onClick={handleSubmit}
				style={{ flexShrink: 0 }}
				rightSection={
					<Icon path={iconPlus} />
				}
			>
				Create {isRelation ? "relation" : "record"}
			</Button>
		</Drawer>
	);
}
