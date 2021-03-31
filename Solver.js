/** @author Vatroslav Vrbanic | vatro */

import * as acorn from 'acorn'
import chalk from 'chalk'
import { mkdir, open, readFile, writeFile } from 'fs/promises'
import os from 'os'
import { join, parse, relative, resolve } from 'path'
import ts from 'typescript'

export default class Solver {
	constructor(
		orig_file_path,
		spinner,
		three_exports_map,
		const_exports_map,
		attributes_exports_map,
		curves_exports_map,
		callback,
		process_dts,
		selected_three_has_types_included
	) {
		// the directory `npx threeshake` was executed from is considered to be the 'project root'
		const project_root_abs = process.cwd()

		const src_new = join(project_root_abs, 'src/')
		const jsm_path = join(project_root_abs, 'original/examples/jsm/')

		let imports = []
		let rest = []
		const new_import_declarations = new Map()

		let has_dts = false
		let dts_orig_file_path = ''
		let dts_dest_path = ''
		let dts_imports = []
		let dts_rest = []
		const dts_new_import_declarations = new Map()

		// dependencies not in the three-module
		const dep_queue = []

		const dest_file_path = orig_file_path.replace(jsm_path, src_new)
		spinner.start(`processing file '${dest_file_path}'`)

		this.doit = async function () {
			await do_process()
			await write_js()

			if (process_dts) {
				await do_process_dts(true)
				await write_dts()
			}

			callback(dep_queue, orig_file_path, has_dts)
		}

		const threeshaked_str = `/* imports resolved & reprinted with https://github.com/vatro/threeshake */${os.EOL}`

		//  TODO  WHY?  here and there (not always) the buffer was a bit too short (2-3 bytes) when reading
		const buff_margin = 20

		async function generate_new_import_declarations_str(imp_decl, is_dts) {
			let imp_decl_str = ''

			const max_names_before_break = 2

			// skip brackets if e.g. import * as foo from "..."
			let sb = false

			imp_decl.forEach((names, p) => {
				const opener = `import {${names.length > max_names_before_break ? `${os.EOL}` : ' '}`
				imp_decl_str += opener

				for (let i = 0; i < names.length; i++) {
					// e.g. import * as foo from "..."
					if (names[i].indexOf('*') > -1) {
						sb = true
						// replace opener
						imp_decl_str = imp_decl_str.substring(0, imp_decl_str.length - opener.length)
						imp_decl_str += 'import '
					}

					imp_decl_str += `${names.length > max_names_before_break ? '\t' : ''}${names[i]}${i < names.length - 1 ? ',' : ''}${
						names.length > max_names_before_break ? `${os.EOL}` : sb ? '' : ' '
					}` // no whitespace if no bracket
				}

				// d.ts files with single quotes (@types/three style)
				// see three 126 : three.js now also using single quotes
				// skip brackets if e.g. import * as foo from "..."
				imp_decl_str += `${sb ? '' : '}'} from '${p}'${os.EOL}`

				sb = false
			})

			// remove last break
			const eol = Buffer.from(os.EOL, 'utf8')
			imp_decl_str = imp_decl_str.substring(0, imp_decl_str.length - eol.length)

			return imp_decl_str
		}

		async function write_js() {
			try {
				const filehandle = await open(orig_file_path, 'r')

				const imp_decl_str = await generate_new_import_declarations_str(new_import_declarations, false)

				// js files need 2 additional breaks
				const buff_imports = Buffer.from(`${threeshaked_str}${os.EOL}${imp_decl_str}${os.EOL}${os.EOL}`)

				const eol = Buffer.from(os.EOL)
				const rest_buff_length = rest[rest.length - 1].end - rest[0].start + buff_margin
				const buffer_rest = Buffer.alloc(rest_buff_length)

				await filehandle.read(buffer_rest, 0, rest_buff_length, rest[0].start)
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

		async function write_dts() {
			if (has_dts) {
				try {
					const filehandle = await open(dts_orig_file_path, 'r')

					const dts_imp_decl_str = await generate_new_import_declarations_str(dts_new_import_declarations, true)

					const buff_imports = Buffer.from(`${threeshaked_str}${os.EOL}${dts_imp_decl_str}`)
					const eol = Buffer.from(os.EOL, 'utf8')
					const rest_buff_length = dts_rest[dts_rest.length - 1].end - dts_rest[0].pos + buff_margin
					const buffer_rest = Buffer.alloc(rest_buff_length)

					await filehandle.read(buffer_rest, 0, rest_buff_length, dts_rest[0].pos)
					filehandle.close()

					let buff_all = Buffer.concat([buff_imports, buffer_rest, eol], buff_imports.length + buffer_rest.length + eol.length)

					const b = buff_all.indexOf(0x00)
					buff_all = buff_all.slice(0, b)

					const folderPath = parse(dts_dest_path).dir
					await mkdir(folderPath, { recursive: true })

					await writeFile(dts_dest_path, buff_all)
				} catch (err) {
					console.log(err)
				}
			}
		}

		function push_declaration(map, left, p) {
			if (!map.has(p)) map.set(p, [])
			map.get(p).push(left)
		}

		function get_posix_style_path(relative_import_path) {
			let p_posix = relative_import_path.replace(/\\/g, '/')
			if (p_posix.indexOf('/') < 0) p_posix = './' + p_posix
			return p_posix
		}

		function get_posix_style_path_dts(relative_import_path) {
			let p_posix = relative_import_path.replace(/\\/g, '/')
			if (p_posix.indexOf('.') < 0) p_posix = './' + p_posix
			return p_posix
		}

		// double quoted import statements in three.js files (three.js style)
		async function do_process() {
			const file_source = await readFile(orig_file_path, 'utf8')
			const parsed_file = acorn.parse(file_source, { ecmaVersion: 2020, sourceType: 'module', locations: 'true' })

			const file_dest_dir = parse(dest_file_path).dir

			imports = parsed_file.body.filter((node) => node.type === 'ImportDeclaration')
			rest = parsed_file.body.filter((node) => node.type !== 'ImportDeclaration')

			for (let i = 0; i < imports.length; i++) {
				const node = imports[i]

				if (node.source.value.indexOf('three.module.js') > -1) {
					const specifiers = node.specifiers

					for (let j = 0; j < specifiers.length; j++) {
						const specifier = specifiers[j]

						const name = specifier.imported.name
						const as_name = specifier.local.name

						if (name.indexOf('Material') < 0 && name.indexOf('Geometry') < 0) {
							if (three_exports_map.get(name)) {
								const export_path = three_exports_map.get(name)
								const path_in_src = export_path.replace('./', src_new)

								const relative_import_path = relative(file_dest_dir, path_in_src)
								const p = get_posix_style_path(relative_import_path)

								const left = name === as_name ? name : `${name} as ${as_name}`
								push_declaration(new_import_declarations, left, p)
							} else if (const_exports_map.get(name)) {
								const const_dir = src_new

								const relative_import_path = relative(file_dest_dir, const_dir)
								const p_posix = get_posix_style_path(relative_import_path)

								const left = name === as_name ? name : `${name} as ${as_name}`
								const p = `${p_posix}/constants.js`

								push_declaration(new_import_declarations, left, p)
							} else if (attributes_exports_map.get(name)) {
								const attr_dir = join(src_new, 'core/')

								const relative_import_path = relative(file_dest_dir, attr_dir)
								const p_posix = get_posix_style_path(relative_import_path)

								const left = name === as_name ? name : `${name} as ${as_name}`
								const p = `${p_posix}/BufferAtrribute.js`

								if (!new_import_declarations.has(p)) {
									new_import_declarations.set(p, [])
								}

								new_import_declarations.get(p).push(left)
							} else if (curves_exports_map.get(name)) {
								const curves_dir = join(src_new, 'extras/curves/')

								const relative_import_path = relative(file_dest_dir, curves_dir)
								const p_posix = get_posix_style_path(relative_import_path)

								const left = name === as_name ? name : `${name} as ${as_name}`
								const p = `${p_posix}/Curves.js`

								push_declaration(new_import_declarations, left, p)
							} else {
								if ('tofix' in new_import_declarations === false) {
									new_import_declarations.tofix = []
								}

								new_import_declarations.tofix.push(`${name}`)
							}
						} else if (name.indexOf('Material') > -1) {
							const mat_dir = join(src_new, 'materials/')

							const relative_import_path = relative(file_dest_dir, mat_dir)
							const p_posix = get_posix_style_path(relative_import_path)

							const left = name === as_name ? name : `${name} as ${as_name}`
							const p = `${p_posix}/Materials.js`

							push_declaration(new_import_declarations, left, p)
						} else if (name.indexOf('Geometry') > -1) {
							const geom_dir = join(src_new, 'geometries/')

							const relative_import_path = relative(file_dest_dir, geom_dir)
							const p_posix = get_posix_style_path(relative_import_path)

							const left = name === as_name ? name : `${name} as ${as_name}`
							const p = `${p_posix}/Geometries.js`

							push_declaration(new_import_declarations, left, p)
						}
					}
				} else {
					// for all other dependencies (examples folder) predict path first and put in queue for copying / processing
					const specifiers = node.specifiers

					for (let j = 0; j < specifiers.length; j++) {
						const specifier = specifiers[j]

						let name
						let as_name

						// e.g. `import * as foo from '...'`
						if (specifier.type === 'ImportNamespaceSpecifier') {
							name = '*'
							as_name = specifier.local.name
						} else {
							name = specifier.imported.name
							as_name = specifier.local.name
						}

						// parent folder of the file in examples
						const file_orig_dir = parse(orig_file_path).dir

						const orig_import_path = node.source.value
						const orig_path_absolute = resolve(file_orig_dir, orig_import_path)
						const new_path_predicted = orig_path_absolute.replace(jsm_path, src_new)

						// put import / file in copy-queue check
						let insert_to_dep_queue = true

						for (let k = 0; k < dep_queue.length; k++) {
							if (dep_queue[k].source_path === orig_path_absolute) {
								insert_to_dep_queue = false
							}
						}

						if (insert_to_dep_queue) {
							dep_queue.push({
								filename: name,
								source_path: orig_path_absolute,
								target_path: new_path_predicted,
								parent: parse(orig_file_path).name
							})
						}

						const relative_import_path = relative(file_dest_dir, new_path_predicted)
						const p = get_posix_style_path(relative_import_path)

						const left = name === as_name ? name : `${name} as ${as_name}`

						push_declaration(new_import_declarations, left, p)
					}
				}
			}
		}

		// single quotes in d.ts files in order to comply with @types/three style
		async function do_process_dts(detect_dependencies) {
			spinner.text = 'Adding definition file ...'

			let types_jsm_path

			// TODO  cleanup below ...
			//for three versions > 93 && < 126 use another path, as there types are included
			if (selected_three_has_types_included) {
				//types_jsm_path = join(project_root_abs, 'original/examples/jsm/')
				types_jsm_path = jsm_path
				dts_orig_file_path = orig_file_path.replace('.js', '.d.ts')
			} else {
				types_jsm_path = join(project_root_abs, 'node_modules/@types/three/examples/jsm/')
				// adjust path to target @types/three
				dts_orig_file_path = orig_file_path.replace(jsm_path, types_jsm_path).replace('.js', '.d.ts')
			}

			/*
			const types_jsm_path = join(project_root_abs, 'node_modules/@types/three/examples/jsm/')
			// adjust path to target @types/three
			dts_orig_file_path = orig_file_path.replace(jsm_path, types_jsm_path).replace('.js', '.d.ts')
			*/

			dts_dest_path = dest_file_path.replace('.js', '.d.ts')

			let file_source
			try {
				file_source = await readFile(dts_orig_file_path, 'utf8')
				has_dts = true
			} catch (err) {
				spinner.warn(
					chalk.yellow(`missing d.ts file: ${dts_orig_file_path.replace(types_jsm_path, '')} not found in ${types_jsm_path}`)
				)
				has_dts = false
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
						const as_name = specifier.propertyName //  TODO  ??? check if correct like this! where does it apply?

						const path_in_src = src_new
						const file_dest_dir = parse(dest_file_path).dir
						const relative_import_path = relative(file_dest_dir, path_in_src)
						const p_posix = get_posix_style_path_dts(relative_import_path)

						//  TODO  ??? check if correct like this! where does it apply?
						const left = name && !as_name ? name : `${name} as ${as_name}`
						const p = `${p_posix}/Three`

						push_declaration(dts_new_import_declarations, left, p)
					}
				} else {
					const specifiers = node.importClause.namedBindings.elements

					for (let j = 0; j < specifiers.length; j++) {
						const specifier = specifiers[j]

						const name = specifier.name.escapedText
						const as_name = specifier.propertyName //  TODO  ??? check if correct like this! where does it apply?

						const file_orig_dir = parse(orig_file_path).dir
						const orig_import_path = node.moduleSpecifier.text
						const orig_path_absolute = resolve(file_orig_dir, orig_import_path)
						const new_path_predicted = orig_path_absolute.replace(jsm_path, src_new)

						if (detect_dependencies) {
							let insert_to_dep_queue = true

							for (let k = 0; k < dep_queue.length; k++) {
								const noJSPath = dep_queue[k].source_path.replace('.js', '')

								if (noJSPath === orig_path_absolute) {
									insert_to_dep_queue = false
								}
							}

							if (insert_to_dep_queue) {
								dep_queue.push({
									filename: name,
									source_path: orig_path_absolute + '.js',
									target_path: new_path_predicted + '.js',
									parent: parse(orig_file_path).name
								})
							}
						}

						const file_dest_dir = parse(dest_file_path).dir
						const relative_import_path = relative(file_dest_dir, new_path_predicted)
						const p = get_posix_style_path_dts(relative_import_path)

						const left = name && !as_name ? name : `${name} as ${as_name}`

						push_declaration(dts_new_import_declarations, left, p)
					}
				}
			}
		}
	}
}
