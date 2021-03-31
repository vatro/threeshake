/** @author Vatroslav Vrbanic | vatro */

import chalk from 'chalk'
import { mkdir, open, readFile, writeFile } from 'fs/promises'
import os from 'os'
import { parse, relative, resolve } from 'path'
import ts from 'typescript'

export default class Migrator {
	constructor(source_file_path, spinner, types_root_path, dest_root_path, callback) {
		let dest_file_path = ''
		let dts_imports = []
		let dts_rest = []
		const dts_new_import_declarations = new Map()

		const threeshaked_str = `/* imports resolved & reprinted with https://github.com/vatro/threeshake */${os.EOL}`
		const buff_margin = 20

		this.doit = async function () {
			await process_dts()
			await write_dts()

			callback(dest_file_path)
		}

		async function generate_new_import_declarations_str(imp_decl) {
			let imp_decl_str = ''

			const max_names_before_break = 2

			imp_decl.forEach((names, p) => {
				imp_decl_str += `import {${names.length > max_names_before_break ? `${os.EOL}` : ' '}`
				for (let i = 0; i < names.length; i++) {
					imp_decl_str += `${names.length > max_names_before_break ? '\t' : ''}${names[i]}${i < names.length - 1 ? ',' : ''}${
						names.length > max_names_before_break ? `${os.EOL}` : ' '
					}`
				}

				// d.ts files with single quotes (@types/three style)
				// see three 126 : three.js now also using single quotes
				imp_decl_str += `} from '${p}'${os.EOL}`
			})

			// remove last break
			const eol = Buffer.from(os.EOL, 'utf8')
			imp_decl_str = imp_decl_str.substring(0, imp_decl_str.length - eol.length)

			return imp_decl_str
		}

		async function write_dts() {
			try {
				const filehandle = await open(source_file_path, 'r')

				const dts_imp_decl_str = await generate_new_import_declarations_str(dts_new_import_declarations)

				const buff_imports = Buffer.from(`${threeshaked_str}${os.EOL}${dts_imp_decl_str}`)
				const eol = Buffer.from(os.EOL, 'utf8')
				const rest_buff_length = dts_rest[dts_rest.length - 1].end - dts_rest[0].pos + buff_margin
				const buffer_rest = Buffer.alloc(rest_buff_length)

				await filehandle.read(buffer_rest, 0, rest_buff_length, dts_rest[0].pos)
				filehandle.close()

				let buff_all = Buffer.concat([buff_imports, buffer_rest, eol], buff_imports.length + buffer_rest.length + eol.length)

				const b = buff_all.indexOf(0x00)
				buff_all = buff_all.slice(0, b)

				const folderPath = parse(dest_file_path).dir
				await mkdir(folderPath, { recursive: true })

				await writeFile(dest_file_path, buff_all)
			} catch (err) {
				console.log(err)
			}
		}

		function push_declaration(map, left, p) {
			if (!map.has(p)) map.set(p, [])
			map.get(p).push(left)
		}

		function get_posix_style_path(import_path_predicted_rel) {
			let p_posix = import_path_predicted_rel.replace(/\\/g, '/')
			if (p_posix.indexOf('.') < 0) p_posix = './' + p_posix
			return p_posix
		}

		async function process_dts() {
			spinner.text = 'Adding definition file ...'

			dest_file_path = source_file_path.replace(types_root_path, dest_root_path)

			// debugger

			let file_source
			try {
				file_source = await readFile(source_file_path, 'utf8')
			} catch (err) {
				spinner.warn(chalk.yellow.italic(`${parse(source_file_path).file} not available`))
				return
			}

			const parsed_file = ts.createSourceFile('temp.ts', file_source, ts.ScriptTarget.ES2020, false, ts.ScriptKind.TS)

			dts_imports = parsed_file.statements.filter((node) => node.importClause)
			dts_rest = parsed_file.statements.filter((node) => !node.importClause)

			for (let i = 0; i < dts_imports.length; i++) {
				const node = dts_imports[i] // parsed_file.statements[i]

				if (node.moduleSpecifier.text.indexOf('/Three') > -1) {
					const specifiers = node.importClause.namedBindings.elements

					for (let j = 0; j < specifiers.length; j++) {
						const specifier = specifiers[j]

						const name = specifier.name.escapedText
						const as_name = specifier.propertyName //  TODO  ???

						const dest_file_root_abs = parse(dest_file_path).dir
						const import_path_predicted_rel = relative(dest_file_root_abs, dest_root_path)
						const p_posix = get_posix_style_path(import_path_predicted_rel)

						//  TODO  ???
						const left = name && !as_name ? name : `${name} as ${as_name}`
						const p = `${p_posix}/Three`

						push_declaration(dts_new_import_declarations, left, p)
					}
				} else {
					const specifiers = node.importClause.namedBindings.elements

					for (let j = 0; j < specifiers.length; j++) {
						const specifier = specifiers[j]

						const name = specifier.name.escapedText
						const as_name = specifier.propertyName //  TODO  ???

						const source_file_root_abs = parse(source_file_path).dir
						const import_path_in_source_file_rel = node.moduleSpecifier.text
						const import_path_in_source_file_abs = resolve(source_file_root_abs, import_path_in_source_file_rel)
						const import_path_predicted_abs = import_path_in_source_file_abs.replace(types_root_path, dest_root_path)

						const dest_file_root_abs = parse(dest_file_path).dir
						const import_path_predicted_rel = relative(dest_file_root_abs, import_path_predicted_abs)
						const p = get_posix_style_path(import_path_predicted_rel)

						const left = name && !as_name ? name : `${name} as ${as_name}`

						push_declaration(dts_new_import_declarations, left, p)
					}
				}
			}
		}
	}
}
