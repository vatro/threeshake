/** @author Vatroslav Vrbanic | vatro */

import * as acorn from 'acorn'
import chalk from 'chalk'
import { exec } from 'child_process'
import extract from 'extract-zip'
import { createWriteStream } from 'fs'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'fs/promises'
import glob from 'glob'
import https from 'https'
import inquirer from 'inquirer'
import ora from 'ora'
import { dirname, join, parse, relative, resolve } from 'path'
import readline from 'readline'
import rimraf from 'rimraf'
import stripJsonComments from 'strip-json-comments'
import { fileURLToPath } from 'url'
import Constants from './Constants.js'
import Migrator from './Migrator.js'
import Solver from './Solver.js'

export default class Shaker {
	constructor() {
		const cli_args_sliced = process.argv.slice(2)

		// the root of threeshake.js file
		const threeshake_root_abs = dirname(fileURLToPath(import.meta.url))

		// the directory `npx threeshake` was executed from is considered to be the 'project root'
		const project_root_abs = process.cwd()

		const config_file_name = Constants.CONFIG_FILE_NAME
		const config_path_abs = join(project_root_abs, config_file_name)

		const state_file_name = Constants.STATE_FILE_NAME
		const state_path_abs = join(project_root_abs, state_file_name)

		const pkj_file_name = Constants.PKJ_FILE_NAME
		const pkj_file_path_abs = join(project_root_abs, pkj_file_name)

		const pkj_lock_file_name = Constants.PKJ_LOCK_FILE_NAME
		const pkj_lock_file_path_abs = join(project_root_abs, pkj_lock_file_name)

		const temp_zip_dir_name = Constants.TEMP_ZIP_DIR_NAME
		const temp_zip_dir_path_abs = join(project_root_abs, temp_zip_dir_name)

		const temp_unzip_dir_name = Constants.TEMP_UNZIP_DIR_NAME
		const temp_unzip_dir_path_abs = join(project_root_abs, temp_unzip_dir_name)

		const pfx = Constants.PFX

		let has_config = false
		let has_state = false
		let has_pkj = false

		let src_folder_in_new
		let original_abs
		let src_folder_in_temp_unzip
		let src_folder_in_original
		let jsm_folder_in_temp_unzip
		let jsm_folder_in_original

		let current_config
		let current_state

		let latest_three

		let selected_three_version
		let state_three_version
		let selected_three_has_types
		let selected_three_has_types_included
		let selected_three_has_deftyped_types

		let three_exports_map
		let const_exports_map
		let attributes_exports_map
		let curves_exports_map

		// see https://github.com/sindresorhus/ora#readme
		let spinner = ora()

		this.init = async () => {
			clearTerminal()

			console.log('Threeshaker > init!')
			console.log('Threeshaker > project_root_abs: ', project_root_abs)
			console.log('Threeshaker > cli_args_sliced: ', cli_args_sliced)

			await get_latest_three_version()

			if (cli_args_sliced.length === 1 && cli_args_sliced.indexOf('-init') === 0) {
				on_init()
			} else if (cli_args_sliced.length === 0) {
				on_threeshake()
			} else if (cli_args_sliced.length === 1 && cli_args_sliced.indexOf('-testdeftypes') === 0) {
				test_deftypes()
			}
		}

		async function on_init() {
			await check_current_dir()

			if (has_config) {
				await get_current_config()

				await new Promise((resolve, reject) => {
					ask_before_init_purge(resolve, reject)
				}).catch(() => {
					console.log('👋 OK-BYE-BYE!')
					process.exit()
				})

				await purge_folders()
			}

			await create_fresh_config_json()
			spinner.succeed(`${pfx} added fresh threeshake.config.json`)

			await create_fresh_state_json()
			spinner.succeed(`${pfx} added fresh threeshake.state.json`)

			// silent
			//if (has_pkj && has_config && current_config.typings === false) {
			// RECONSIDER  always uninstalling types on -init
			if (has_pkj) {
				// debugger
				await uninstall_three_types()
			}

			if (has_pkj === false) {
				// debugger
				await create_fresh_pkj()
				spinner.succeed(`${pfx} added fresh package.json`)
			}
		}

		async function create_fresh_config_json() {
			try {
				await copyFile(join(threeshake_root_abs, `default.${config_file_name}`), config_path_abs)
			} catch (err) {
				console.log(err)
			}
		}

		async function create_fresh_state_json() {
			try {
				await clear_state()
			} catch (err) {
				console.log(err)
			}
		}

		async function create_fresh_pkj() {
			await new Promise((resolve, reject) => rimraf(pkj_lock_file_path_abs, () => resolve()))

			const content = {}

			try {
				await writeFile(pkj_file_path_abs, JSON.stringify(content, null, 4))
			} catch (err) {
				console.log(err)
			}
		}

		// see https://gist.github.com/timneutkens/f2933558b8739bbf09104fb27c5c9664
		function clearTerminal() {
			const blank = '\n'.repeat(process.stdout.rows)
			console.log(blank)
			readline.cursorTo(process.stdout, 0, 0)
			readline.clearScreenDown(process.stdout)
		}

		async function check_current_dir() {
			await readdir(project_root_abs).then((files) => {
				for (let i = 0; i < files.length; i++) {
					if (files[i] === config_file_name) has_config = true
					if (files[i] === state_file_name) has_state = true
					if (files[i] === pkj_file_name) has_pkj = true
				}
			})
		}

		async function get_current_config() {
			const c = await readFile(config_path_abs, 'utf8')
			current_config = JSON.parse(stripJsonComments(c))

			src_folder_in_new = join(resolve(project_root_abs, current_config.dest), 'src')
			original_abs = resolve(project_root_abs, current_config.original)
			src_folder_in_original = join(original_abs, 'src')
			jsm_folder_in_original = join(original_abs, 'examples/jsm')
		}

		async function get_current_state() {
			const s = await readFile(state_path_abs, 'utf8')
			current_state = JSON.parse(stripJsonComments(s))
			state_three_version = current_state.three_version
		}

		async function get_latest_three_version() {
			await new Promise((resolve, reject) => {
				exec('npm view three version --json', (err, stdout, stderr) => {
					if (err) {
						reject(err)
					}
					const result = JSON.parse(stdout)
					latest_three = Number(result.substring(2, result.length - 2))
					resolve()
				})
			}).catch((err) => console.log(err))
		}

		async function on_threeshake() {
			await check_current_dir()

			if (has_config) {
				await get_current_config()

				if (has_state) {
					await get_current_state()
				} else {
					await new Promise((resolve, reject) => {
						ask_create_fresh_state(resolve, reject)
					}).catch(() => {
						process.exit()
					})

					await create_fresh_state_json()
				}

				if (current_config.three) {
					// check current_config.three value and then donwload / purge / redownload three
					if (typeof current_config.three === 'number') {
						if (current_config.three <= latest_three) {
							selected_three_version = current_config.three

							src_folder_in_temp_unzip = join(
								project_root_abs,
								`${temp_unzip_dir_name}/three.js-r${selected_three_version}/src`
							)
							jsm_folder_in_temp_unzip = join(
								project_root_abs,
								`${temp_unzip_dir_name}/three.js-r${selected_three_version}/examples/jsm`
							)

							selected_three_has_types = has_types(selected_three_version)
							selected_three_has_types_included = has_types_included(selected_three_version)
							selected_three_has_deftyped_types = has_deftyped_types(selected_three_version)

							if (selected_three_has_types === false && current_config.typings) {
								spinner.warn(
									chalk.yellow(
										`${pfx} threeshake.config.json > 'typings': true > typings for three.js ${selected_three_version} not available!`
									)
								)
							}
						} else {
							spinner.fail(
								chalk.red(
									`${pfx} threeshake.config.json > "three" version ${current_config.three} hasn't been released yet!`
								)
							)
							process.exit()
						}
					} else {
						spinner.fail(chalk.red(`${pfx} threeshake.config.json > "three" has wrong value type (has to be a number)!`))
						process.exit()
					}
				} else {
					spinner.fail(
						chalk.red(`${pfx} threeshake.config.json > "three" property not found, probably commented out (default file).`)
					)
					process.exit()
				}
			} else {
				spinner.fail(chalk.red(`${pfx} 'threeshake.config.json' not found, please execute 'npx threeshake -init' first!`))
				process.exit()
			}

			if (state_three_version === 'none') {
				await download_only()
			} else if (state_three_version !== selected_three_version) {
				await new Promise((resolve, reject) => {
					ask_before_threeshake_purge(resolve, reject)
				}).catch(() => {
					console.log('👋 OK-BYE-BYE!')
					process.exit()
				})

				await purge_and_download()
			} else {
				/* nothing, just process */
			}

			await map_three()
			await process_deftyped_types()
			on_modify()
		}

		async function ask_create_fresh_state(resolve, reject) {
			const questions = [
				{
					type: 'confirm',
					name: 'continue',
					message: chalk.reset.yellow(`${pfx} 'threeshake.state.json' (needed) not found!\n` + 'Create a fresh one and continue?')
				}
			]

			await inquirer.prompt(questions).then((answers) => {
				answers.continue ? resolve() : reject()
			})
		}

		async function test_deftypes() {
			selected_three_version = 126
			selected_three_has_types = has_types(selected_three_version)
			selected_three_has_deftyped_types = has_deftyped_types(selected_three_version)

			spinner.info(chalk.bold.blue(`${pfx} mapping three modules ...`))
			await map_three()
			await process_deftyped_types()
		}

		async function process_deftyped_types() {
			if (current_config.typings) {
				if (selected_three_has_types) {
					if (selected_three_has_deftyped_types) {
						await install_three_types()
						await migrate_types_subfolder('src')
					} else {
						// nothing, types will be included in src-folder already
					}
				}
			}
		}

		async function migrate_types_subfolder(subfolder) {
			const options = { spinner: 'dots' }
			spinner = ora(options)

			spinner.start(`${pfx} migrating @types/three/${subfolder} ...`)
			await migrate_all_dts_in(subfolder)
			spinner.succeed(`${pfx} migrated @types/three/${subfolder}`)
		}

		async function migrate_all_dts_in(subfolder) {
			const node_modules_dir = `node_modules/@types/three/${subfolder}`
			const types_root_path = join(project_root_abs, node_modules_dir)
			const dest_root_path = join(resolve(project_root_abs, current_config.dest), subfolder)

			await new Promise((resolve, reject) => {
				const resolve_root_promise = resolve

				const glob_options = {
					sync: false,
					absolute: true,
					root: project_root_abs
				}

				glob(`/${node_modules_dir}/**/*.d.ts`, glob_options, async (er, matches) => {
					if (er) {
						spinner.fail(chalk.red(`${pfx} oops! 😬 something went wrong while migrating @types/three!`))
						console.log(er)
						process.exit()
					}

					await new Promise((resolve, reject) => migrate_all_dts(matches, types_root_path, dest_root_path, resolve))

					resolve_root_promise()
				})
			})
		}

		async function migrate_all_dts(matches, types_root_path, dest_root_path, resolve_glob_callback) {
			let to_solve_total = matches.length
			let i = 0

			async function migrate_dts_loop() {
				await new Promise((resolve, reject) => migrate_dts_file(matches[i], types_root_path, dest_root_path, resolve))

				to_solve_total--
				i++

				if (to_solve_total > 0) {
					//if (to_solve_total > matches.length - 2) {
					migrate_dts_loop()
				} else {
					resolve_glob_callback()
				}
			}

			migrate_dts_loop()
		}

		async function migrate_dts_file(match, types_root_path, dest_root_path, resolve_parent) {
			const dts_migrator = new Migrator(match, spinner, types_root_path, dest_root_path, (file_dest_path) => {
				resolve_parent()
			})

			dts_migrator.doit()
		}

		async function map_three() {
			const options = { spinner: 'dots' }
			spinner = ora(options)
			spinner.start(`${pfx} mapping three modules ...`)

			await map_threejs()
			await map_constants()
			await map_bufferattributes()
			await map_curves()

			spinner.succeed(`${pfx} mapped'em`)
		}

		function has_types(version) {
			return version >= 92
		}

		function has_types_included(version) {
			return version > 93 && version < 126
		}

		function has_deftyped_types(version) {
			return (version >= 92 && version <= 93) || version >= 126
		}

		async function ask_before_init_purge(resolve, reject) {
			const questions = [
				{
					type: 'confirm',
					name: 'continue',
					prefix: '👀',
					message: chalk.reset.yellow(
						"'threeshake -init' command will delete any existing folders specified\nin your 'threeshake.config.json' file:\n\n" +
							`"original": ${original_abs}\n` +
							`"dest": ${src_folder_in_new}\n\n` +
							'Your current threeshake configuration and state will be lost.\n\n' +
							'Do you still wish to continue?'
					)
				}
			]

			await inquirer.prompt(questions).then((answers) => {
				answers.continue ? resolve() : reject()
			})
		}

		async function ask_before_threeshake_purge(resolve, reject) {
			const questions = [
				{
					type: 'confirm',
					name: 'continue',
					prefix: '👀',
					message: chalk.reset.yellow(
						"You seem to have specified a different three version!\nContinuing will delete any existing folders specified\nin your 'threeshake.config.json' file:\n\n" +
							`"original": ${original_abs}\n` +
							`"dest": ${src_folder_in_new}\n\n` +
							'... before recreating them.\nYour current threeshake state will also be lost!\n\n' +
							'Do you still wish to continue?'
					)
				}
			]

			await inquirer.prompt(questions).then((answers) => {
				answers.continue ? resolve() : reject()
			})
		}

		async function purge_and_download() {
			await purge_folders()
			await uninstall_three_types()
			await download_three()
			await update_three_version_in_state()
		}

		async function download_only() {
			await uninstall_three_types()
			await download_three()
			await update_three_version_in_state()
		}

		async function update_three_version_in_state() {
			const s = await readFile(state_path_abs, 'utf8')
			current_state = JSON.parse(stripJsonComments(s))
			current_state.three_version = selected_three_version

			try {
				await writeFile(state_path_abs, JSON.stringify(current_state, null, 4))
			} catch (err) {
				console.log(err)
			}
		}

		async function purge_folders() {
			await new Promise((resolve, reject) => rimraf(src_folder_in_new, () => resolve()))
			await new Promise((resolve, reject) => rimraf(original_abs, () => resolve()))
			await new Promise((resolve, reject) => rimraf(temp_zip_dir_path_abs, () => resolve()))
		}

		async function download_three() {
			await create_zip_folder()
			await new Promise((resolve, reject) => download_three_zip(resolve, reject))
			spinner.succeed(`${pfx} downloaded three ${selected_three_version} source files (zipped)`)
			await create_unzip_folder()
			await unzip_three()
			spinner.succeed(`${pfx} extracted r${selected_three_version}.zip`)
			await copy_to_original_folder()
			spinner.succeed(`${pfx} copied relevant folders`)
			await delete_temp_folders()
			spinner.succeed(`${pfx} deleted temp folders`)
		}

		async function delete_temp_folders() {
			spinner.start(`${pfx} deleting temp folders ...`)
			await new Promise((resolve, reject) => rimraf(temp_unzip_dir_path_abs, () => resolve()))

			// leave zip
			// await new Promise((resolve, reject) => rimraf(temp_zip_dir_path_abs, () => res()))
		}

		async function create_zip_folder() {
			await mkdir(temp_zip_dir_path_abs, { recursive: false }).catch((e) => {
				e.code === 'EEXIST' ? console.info(`'${temp_zip_dir_name}' folder already exists!`) : console.log(e)
			})
		}

		function download_three_zip(resolve, reject) {
			const download_url = `https://codeload.github.com/mrdoob/three.js/zip/refs/tags/r${selected_three_version}`

			const fileStream = createWriteStream(`${temp_zip_dir_name}/r${selected_three_version}.zip`, {
				autoClose: true,
				emitClose: true
			})

			spinner.info(chalk.blue.bold(`${pfx} starting download of ${download_url}`))

			https.get(download_url, { headers: { connection: 'keep-alive' } }, (result) => {
				result.pipe(fileStream)
			})

			function show_download_progressing() {
				const options = { spinner: 'aesthetic', color: 'blue' }
				spinner = ora(options)
				spinner.start(` downloading three ${selected_three_version} ...`)
			}

			show_download_progressing()

			fileStream.on('close', () => resolve())
		}

		async function create_unzip_folder() {
			await mkdir(temp_unzip_dir_path_abs, { recursive: false }).catch((e) => {
				e.code === 'EEXIST' ? console.info(`'${temp_unzip_dir_name}' folder already exists!`) : console.log(e)
			})
		}

		async function unzip_three() {
			show_extracting()
			// return

			const file_name = `r${selected_three_version}.zip`
			const filePath = `${project_root_abs}/${temp_zip_dir_name}/${file_name}`
			const targetPath = `${project_root_abs}/${temp_unzip_dir_name}/`

			function show_extracting() {
				const options = { spinner: 'dots' }
				spinner = ora(options)
				spinner.start(`${pfx} extracting r${selected_three_version}.zip ...`)
			}

			await extract(filePath, { dir: targetPath }).catch((e) => {
				console.log(e)
			})
		}

		async function install_three_types() {
			const options = { spinner: 'dots' }

			spinner = ora(options)
			spinner.start(`${pfx} installing @types/three ...`)

			await new Promise((resolve, reject) => {
				exec(`npm i @types/three@"<0.${selected_three_version + 1}.0" --save-dev`, (err, stdout, stderr) => {
					if (err) {
						spinner.fail(
							chalk.red(
								`${pfx} oops! 😬 something went wrong while trying to install '@types/three@^0.${selected_three_version}.0'!`
							)
						)
						console.log(err)
						process.exit()
					}
					resolve()
				})
			})

			spinner.succeed(`${pfx} installed @types/three`)
		}

		async function uninstall_three_types() {
			// uninstall silently
			/*
            const options = {
                text: `threeshake > uninstalling @types/three ...`,
                spinner: "dots"
            }

            spinner = ora(options)
            spinner.start()
            */

			await new Promise((resolve, reject) => {
				exec('npm uninstall @types/three --save-dev', (err, stdout, stderr) => {
					if (err) {
						spinner.fail(chalk.red(`${pfx} oops! 😬 something went wrong while trying to uninstall '@types/three'!`))
						console.log(err)
						process.exit()
					}
					// console.log(stdout)
					return resolve()
				})
			})

			// spinner.succeed("threeshake > @types/three uninstalled!")
		}

		async function create_original_folder() {
			await mkdir(original_abs, { recursive: true }).catch((e) => {
				e.code === 'EEXIST' ? console.info(`'${original_abs}' folder already exists!`) : console.log(e)
			})
		}

		async function copyDir(src, dest) {
			await mkdir(dest, { recursive: true })
			const entries = await readdir(src, { withFileTypes: true })

			for (const entry of entries) {
				const srcPath = join(src, entry.name)
				const destPath = join(dest, entry.name)

				entry.isDirectory() ? await copyDir(srcPath, destPath) : await copyFile(srcPath, destPath)
			}
		}

		// see https://nodejs.org/dist/latest-v15.x/docs/api/html#fs_fs_copyfile_src_dest_mode_callback
		async function copy_to_original_folder() {
			spinner.start(`${pfx} copying relevant folders ...`)

			try {
				await create_original_folder()

				await copyDir(src_folder_in_temp_unzip, src_folder_in_original)
				await copyDir(src_folder_in_temp_unzip, src_folder_in_new)
				await copyDir(jsm_folder_in_temp_unzip, jsm_folder_in_original)
			} catch (err) {
				console.log(err)
			}
		}

		// --- PROCESSING EXAMPLES/JSM MODULES ---

		let modules_to_solve = []

		async function on_modify() {
			const options = { spinner: 'dots' }
			spinner = ora(options)
			spinner.info(chalk.bold.blue(`${pfx} preparing for modification ...`))

			if (!three_exports_map) {
				spinner.info(chalk.bold.blue(`${pfx} mapping three modules ...`))
				await map_three()
			}

			// Delete all previously added files
			/* 
				Additional comment:
				Comparing current "add" configuration and "state" to diff delete / add files is considered to be too complicated / over the top.
				It would result in a complicated interaction with the user (probably causing confusion / mistakes) when user has to make removal
				decisions based on various dependencies of each module.
			*/

			if (current_state.state?.length > 0 && !running_init()) {
				spinner.info(chalk.bold.blue(`${pfx} cleaning up ...`))
				spinner.start(`${pfx} deleting all previously added modules before modification ...`)

				await delete_all_added_files()

				spinner.succeed(`${pfx} cleaned up`)
				await clear_state()
				spinner.succeed(`${pfx} ready for modification`)
			}

			const jsm_folder_in_original = join(original_abs, 'examples/jsm')

			for (let i = 0; i < current_config.add.length; i++) {
				const file_path_in_original = join(jsm_folder_in_original, current_config.add[i])
				modules_to_solve.push(file_path_in_original)
			}

			// debugger

			if (modules_to_solve.length > 0) {
				spinner.info(chalk.bold.blue(`${pfx} adding selected examples/jsm modules incl. detected dependencies ...`))
				process_files()
			} else {
				spinner.warn(chalk.yellow(`${pfx} 🤔 No examples/jsm modules to add! see 👉 "add":[] in threeshake.config.json`))
				process.exit()
			}
		}

		function running_init() {
			return cli_args_sliced.indexOf('-init') > -1
		}

		async function delete_all_added_files() {
			const state_total = current_state.state.length
			await new Promise((resolve, reject) => delete_files(state_total, resolve))
		}

		async function delete_files(state_total, resolve_delete_all_added_files) {
			const total = state_total
			let current_index = 0
			let deleted = 0

			async function delete_modules() {
				async function del() {
					const js_file = current_state.state[current_index].js
					const dts_file = current_state.state[current_index].dts
					const root_dir = parse(js_file).dir

					await new Promise((resolve, reject) => {
						rimraf(js_file, (err) => {
							if (err) reject(err)
							resolve()
						})
					}).catch((err) => console.log(err))

					await new Promise((resolve, reject) => {
						if (dts_file !== '') {
							rimraf(dts_file, (err) => {
								if (err) reject(err)
								resolve()
							})
						} else {
							resolve()
						}
					}).catch((err) => console.log(err))

					let del_dir = false

					await new Promise((resolve, reject) => {
						readdir(root_dir)
							.then((files) => {
								if (files.length === 0) {
									del_dir = true
									resolve()
								} else {
									resolve()
								}
							})
							.catch((err) => reject(err))
					}).catch((err) => {
						spinner.warn(
							chalk.yellow(
								`${pfx} NOT SEVERE ERROR : Couldn't delete directory found in threeshake.state.config : it was probably deleted manually, will be recreated during the next step if needed.`
							)
						)
						console.log(err)
					})

					await new Promise((resolve, reject) => {
						if (del_dir) {
							rimraf(root_dir, (err) => {
								if (err) reject(err)
								resolve()
							})
						} else {
							resolve()
						}
					}).catch((err) => {
						spinner.warn(
							`${pfx} NOT SEVERE: couldn't delete empty / non existent directory (on 'init' / 'modify') found in threeshake.state.config!`
						)
						console.log(err)
					})
				}

				await del()

				current_index++
				deleted++

				if (deleted < total) {
					delete_modules()
				} else {
					resolve_delete_all_added_files()
				}
			}

			delete_modules()
		}

		let index_to_solve = 0

		const solved_modules_names = []
		const solved_state = []

		async function process_files() {
			if (modules_to_solve.length > 0 && modules_to_solve[index_to_solve]) {
				let module_to_solve_path = ''

				// is dependency detected by the solver
				let is_dep = false

				/*
				libs also get processed, they seem not have three bound dependencies, but they get checked anyway.
				libs / files with no imports will just get reprinted / copied (with a comment / hint on first line).
				*/
				if (typeof modules_to_solve[index_to_solve] === 'string') {
					// absolute path specified by the user
					is_dep = false
					module_to_solve_path = modules_to_solve[index_to_solve]
				} else {
					// dependency detected by the solver
					is_dep = true
					module_to_solve_path = modules_to_solve[index_to_solve].source_path
				}

				const module_to_solve_name = parse(module_to_solve_path).name

				if (module_to_solve_path !== '') {
					if (solved_modules_names.indexOf(module_to_solve_name) < 0) {
						const fp = new Solver(
							module_to_solve_path,
							spinner,
							three_exports_map,
							const_exports_map,
							attributes_exports_map,
							curves_exports_map,
							(found_dependencies, solved_module_path, dts, skipped) => {
								if (found_dependencies.length > 0) {
									modules_to_solve = [...modules_to_solve, ...found_dependencies]
								}

								const solved_module_name = parse(solved_module_path).name
								const solved_module_root_in_original = parse(solved_module_path).dir.replace(`${original_abs}\\`, '')

								spinner.succeed(
									`add ${
										is_dep ? chalk.hex('#cc9900').bold(solved_module_name) : chalk.bold.green(solved_module_name)
									} ${chalk.grey('from ' + solved_module_root_in_original)} ${
										is_dep ? chalk.hex('#cc9900')(`as ${modules_to_solve[index_to_solve].parent} dependency`) : ''
									}`
								)

								solved_modules_names.push(solved_module_name)

								const jsm_folder_in_original = join(original_abs, 'examples/jsm')
								const solved_target_path_js = solved_module_path.replace(jsm_folder_in_original, src_folder_in_new)
								const solved_target_path_dts = dts ? solved_target_path_js.replace('.js', '.d.ts') : ''

								const solved_object = {
									name: solved_module_name,
									js: solved_target_path_js,
									dts: solved_target_path_dts,
									dependency_of: [],
									skipped
								}

								// Save dependency realtionship
								// This is not being used for anything (yet?), but is a nice to have.
								if (is_dep) {
									let index_of_parent
									for (let j = 0; j < solved_state.length; j++) {
										if (solved_modules_names[j] === modules_to_solve[index_to_solve].parent) {
											index_of_parent = j
										}
									}

									const dependency_of_obj = {
										name: modules_to_solve[index_to_solve].parent,
										index_in_state: index_of_parent
									}
									solved_object.dependency_of.push(dependency_of_obj)
								}

								solved_state.push(solved_object)

								// move to next
								index_to_solve++
								process_files()
							},
							(selected_three_has_deftyped_types || selected_three_has_types_included) && current_config.typings,
							selected_three_has_types_included,
							src_folder_in_new,
							jsm_folder_in_original
						)

						fp.doit()
					} else {
						spinner.info(
							chalk.blue.italic(
								`skipped adding '${module_to_solve_name}' (detected as dependency of ${modules_to_solve[index_to_solve].parent}), already added.`
							)
						)

						// save dependency realtionship
						// this is not being used for anything (yet?), but is a nice to have.
						let index_of_depedency
						for (let i = 0; i < solved_state.length; i++) {
							if (solved_state[i].name === module_to_solve_name) {
								index_of_depedency = i
							}
						}

						let index_of_parent
						for (let j = 0; j < solved_state.length; j++) {
							if (solved_state[j].name === modules_to_solve[index_to_solve].parent) {
								index_of_parent = j
							}
						}

						if (solved_state[index_of_depedency].dependency_of.indexOf(index_of_parent) < 0) {
							const dependency_of_obj = { name: modules_to_solve[index_to_solve].parent, index_in_state: index_of_parent }
							solved_state[index_of_depedency].dependency_of.push(dependency_of_obj)
						}

						// move to next
						index_to_solve++
						process_files()
					}
				} else {
					spinner.fail(chalk.red('oops! 🤔 module to solve path is empty!'))
					// debugger
					index_to_solve++
					process_files()
				}
			} else {
				spinner.succeed(`${pfx} added all selected examples/jsm modules incl. detected dependencies`)

				await save_state()

				await update_three_exports()

				spinner.succeed(`${pfx} ${chalk.green.bold('FINISHED! 🥳')}`)
				process.exit()
			}
		}

		async function save_state() {
			const content = {
				three_version: selected_three_version,
				state: solved_state
			}

			try {
				await writeFile(state_path_abs, JSON.stringify(content, null, 4))
			} catch (err) {
				console.log(err)
			}
		}

		async function clear_state() {
			const content = {
				three_version: selected_three_version || 'none',
				state: []
			}

			try {
				await writeFile(state_path_abs, JSON.stringify(content, null, 4))
			} catch (err) {
				console.log(err)
			}
		}

		async function update_three_exports() {
			await update_threejs()
			if (current_config.typings) {
				await update_three_dts()
			}
		}

		async function update_threejs() {
			const threejs_path = join(src_folder_in_new, 'Three.js')
			const str_with_exports = await get_str_with_exports_js()
			await writeFile(threejs_path, str_with_exports)
		}

		async function update_three_dts() {
			const three_dts_path = join(src_folder_in_new, 'Three.d.ts')
			const str_with_exports = await get_str_with_exports_dts()
			if (str_with_exports === '') return

			// this will create a Three.d.ts file when typings.process === 'add' (Three.d.ts was not migrated as when typings.process === 'all')
			await writeFile(three_dts_path, str_with_exports)
		}

		async function get_str_with_exports_js() {
			const str_opener = '\n/* added by threeshake | https://github.com/vatro/threeshake */\n\n'
			const c = await readFile(join(original_abs, 'src/Three.js'), 'utf8')
			let str = c + str_opener

			for (let i = 0; i < solved_state.length; i++) {
				const solved = solved_state[i]

				// don't export libs
				if (parse(solved.js).dir.indexOf('libs') < 0) {
					const left = solved.name
					const right = relative(src_folder_in_new, solved.js).replace(/\\/g, '/')
					str += `export { ${left} } from './${right}'\n`
				}
			}

			return str
		}

		async function get_str_with_exports_dts() {
			let str = ''

			const str_opener = '\n/**\n* added by threeshake | https://github.com/vatro/threeshake\n*/\n'
			const src_folder_in_original = join(original_abs, 'src')
			const types_folder = join(project_root_abs, 'node_modules/@types/three/src/')

			let c
			try {
				if (selected_three_has_types_included) {
					c = await readFile(join(src_folder_in_original, 'Three.d.ts'), 'utf8')
				} else {
					c = await readFile(join(types_folder, 'Three.d.ts'), 'utf8')
				}
			} catch (err) {
				// no Three.d.ts / no types
				if (err.code === 'ENOENT') {
					console.log(err)
					return ''
				}
			}

			str = c + str_opener

			for (let i = 0; i < solved_state.length; i++) {
				const solved = solved_state[i]

				// don't export libs
				if (parse(solved.js).dir.indexOf('libs') < 0) {
					const right = relative(src_folder_in_new, solved.js).replace(/\\/g, '/').replace('.js', '')
					str += `export * from './${right}'\n`
				}
			}

			return str
		}

		// --- MAPPING ---

		async function map_threejs() {
			const fileSource = await readFile(join(original_abs, 'src/Three.js'), 'utf8')
			const parsedFile = acorn.parse(fileSource, { ecmaVersion: 2020, sourceType: 'module', locations: 'true' })
			const three_exports = parsedFile.body.filter((node) => node.type === 'ExportNamedDeclaration')

			three_exports_map = new Map()

			for (let i = 0; i < three_exports.length; i++) {
				const specifiers = three_exports[i].specifiers
				const srcPath = three_exports[i].source.value

				for (let j = 0; j < specifiers.length; j++) {
					three_exports_map.set(three_exports[i].specifiers[j].exported.name, srcPath)
				}
			}
		}

		async function map_constants() {
			const fileSource = await readFile(join(original_abs, 'src/constants.js'), 'utf8')
			const parsedFile = acorn.parse(fileSource, { ecmaVersion: 2020, sourceType: 'module', locations: 'true' })
			const const_exports = parsedFile.body.filter((node) => node.type === 'ExportNamedDeclaration')

			const_exports_map = new Map()

			for (let i = 0; i < const_exports.length; i++) {
				const name = const_exports[i].declaration.declarations[0].id.name
				const srcPath = 'constants'

				const_exports_map.set(name, srcPath)
			}
		}

		async function map_bufferattributes() {
			const fileSource = await readFile(join(original_abs, 'src/core/BufferAttribute.js'), 'utf8')
			const parsedFile = acorn.parse(fileSource, { ecmaVersion: 2020, sourceType: 'module', locations: 'true' })
			const attr_exports = parsedFile.body.filter((node) => node.type === 'ExportNamedDeclaration')

			attributes_exports_map = new Map()

			for (let i = 0; i < attr_exports.length; i++) {
				const specifiers = attr_exports[i].specifiers
				const srcPath = 'BufferAttribute'

				for (let j = 0; j < specifiers.length; j++) {
					attributes_exports_map.set(attr_exports[i].specifiers[j].exported.name, srcPath)
				}
			}
		}

		async function map_curves() {
			const fileSource = await readFile(join(original_abs, 'src/extras/curves/Curves.js'), 'utf8')
			const parsedFile = acorn.parse(fileSource, { ecmaVersion: 2020, sourceType: 'module', locations: 'true' })
			const curves_exports = parsedFile.body.filter((node) => node.type === 'ExportNamedDeclaration')

			curves_exports_map = new Map()

			for (let i = 0; i < curves_exports.length; i++) {
				const specifiers = curves_exports[i].specifiers
				const srcPath = 'Curves'

				for (let j = 0; j < specifiers.length; j++) {
					curves_exports_map.set(curves_exports[i].specifiers[j].exported.name, srcPath)
				}
			}
		}
	}
}
