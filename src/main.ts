import * as core from '@actions/core'
const axios = require('axios').default
import * as constants from './constants'
import fs from 'fs';
import util from 'util';
import * as path from 'path'
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const root = path.join(__dirname, '..')

const cspClient = axios.create({
  baseURL: `${process.env.CSP_API_URL}`,
  timeout: 3000,
  headers: {'Content-Type': 'application/x-www-form-urlencoded'}
});

const vibClient = axios.create({
  baseURL: `${process.env.VIB_PUBLIC_URL}`,
  timeout: 3000,
  headers: {'Content-Type': 'application/json'}
});

interface Config {
  pipeline: string,
  baseFolder: string
}

interface CspToken {
  access_token: string,
  timestamp: number
}

interface CspInput {
  timeout: number,
}


let cachedCspToken: CspToken| null= null

async function run(): Promise<void> {

  //TODO: Refactor so we don't need to do this check
  if (process.env['JEST_TESTS'] !== 'true') return // skip running logic when importing class for npm test

  await runAction()
}

//TODO: After generating objects with OpenAPI we should be able to have a Promise<ExecutionGraph>
export async function runAction(): Promise<any> {

  core.debug(`Running github action.`)
  const config = await loadConfig()
  const startTime = Date.now()

  try {
    let executionGraphId = await createPipeline(config)
    core.info(`Created pipeline with id ${executionGraphId}.`)

    // Now wait until pipeline ends or times out
    let executionGraph = await getExecutionGraph(executionGraphId)
    while (!Object.values(constants.EndStates).includes(executionGraph['status'])) {
      core.info(`Fetched execution graph with id ${executionGraphId}. Status: ${executionGraph['status']}`)
      if (Date.now() - startTime > constants.DEFAULT_EXECUTION_GRAPH_GLOBAL_TIMEOUT) {
        //TODO: Allow user to override the global timeout via action input params
        core.info(`Execution graph ${executionGraphId} timed out. Ending Github Action.`)
        break        
      }
      await sleep(constants.DEFAULT_EXECUTION_GRAPH_CHECK_INTERVAL)
      executionGraph = await getExecutionGraph(executionGraphId)            
    }
    core.info(`Generating action outputs.`)    
    core.setOutput('executionGraphId', executionGraphId)
    core.setOutput('executionGraph', executionGraph)

    // TODO: Fetch logs and results
    // TODO: Upload logs and results as artifacts

    if (!Object.values(constants.EndStates).includes(executionGraph['status'])) {
      core.setFailed(`Execution graph ${executionGraphId} has timed out.`)
    } else {
      if (executionGraph['status'] === constants.EndStates.FAILED) {
        core.setFailed(`Execution graph ${executionGraphId} has failed.`)
      } else {
        core.info(`Execution graph ${executionGraphId} has completed successfully.`)
      }
    }

    return executionGraph
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

export async function getExecutionGraph(executionGraphId: string): Promise<Object> {

  core.debug(`Getting execution graph with id ${executionGraphId}`)
  if (typeof process.env.VIB_PUBLIC_URL === 'undefined') {
    throw new Error('VIB_PUBLIC_URL environment variable not found.')
  } 
  
  let apiToken = await getToken({timeout: constants.CSP_TIMEOUT})
  const response = await vibClient.get(`/v1/execution-graphs/${executionGraphId}`, {headers:{'Authorization':`Bearer ${apiToken}`}});
  //TODO: Handle response codes
  console.log(`Got execution graph ${util.inspect(response.data)}`)
  return response.data
}

export async function createPipeline(config: Config): Promise<string> {

  if (typeof process.env.VIB_PUBLIC_URL === 'undefined') {
    throw new Error('VIB_PUBLIC_URL environment variable not found.')
  } 

  let apiToken = await getToken({timeout: constants.CSP_TIMEOUT})

  try {
    const folderName = path.join(root, constants.DEFAULT_BASE_FOLDER)
    const filename = path.join(folderName, constants.DEFAULT_PIPELINE)
    core.debug(`Reading pipeline file from ${filename}`)
    let pipeline = fs.readFileSync(filename).toString()
    core.debug(`Sending pipeline: ${util.inspect(pipeline)}`)
    //TODO: Define and replace different placeholders: e.g. for values, content folders (goss, jmeter), etc. 

    const response = await vibClient.post("/v1/pipelines", pipeline, {headers:{'Authorization':`Bearer ${apiToken}`}});
    core.debug(`Got create pipeline response data : ${JSON.stringify(response.data)}, headers: ${util.inspect(response.headers)}`)
    //TODO: Handle response codes
    let locationHeader = response.headers['location']?.toString()
    if (typeof locationHeader === 'undefined') {
      throw new Error('Location header not found')
    }
    core.debug(`Location Header: ${locationHeader}`)

    let executionGraphId = locationHeader.substring(locationHeader.lastIndexOf('/') + 1)
    return executionGraphId

  } catch (error) {
    core.debug(`Error: ${JSON.stringify(error)}`)
    throw error
  }
}

export async function getToken(input: CspInput): Promise<string> {

  const config = loadConfig()
  core.debug(`Checking CSP API token... Cached token: ${cachedCspToken}`)
  core.debug(typeof process.env.CSP_API_TOKEN)
  if (typeof process.env.CSP_API_TOKEN === 'undefined') {
    throw new Error('CSP_API_TOKEN secret not found.')
  } 
  if (typeof process.env.CSP_API_URL === 'undefined') {
    throw new Error('CSP_API_URL environment variable not found.')
  } 

  if (cachedCspToken != null && cachedCspToken.timestamp > Date.now()) {
    console.log(`Cached token timestamp: ${cachedCspToken?.timestamp} and now is ${Date.now()}. Timeout is ${input.timeout}`)
    return cachedCspToken.access_token
  }

  try {
    const response = await cspClient.post('/csp/gateway/am/api/auth/api-tokens/authorize', `grant_type=refresh_token&api_token=${process.env.CSP_API_TOKEN}`);
    //TODO: Handle response codes
    if (typeof response.data === 'undefined' || typeof response.data.access_token === 'undefined') {
      throw new Error('Could not fetch access token.')
    } 

    cachedCspToken = {
      access_token: response.data.access_token,
      timestamp: Date.now() + input.timeout
    }
  
    return response.data.access_token;

  } catch (error) {
    throw error
  }
}

export async function loadConfig(): Promise<Config> {

  let pipeline = constants.DEFAULT_PIPELINE
  let baseFolder = constants.DEFAULT_BASE_FOLDER

  const folderName = path.join(root, constants.DEFAULT_BASE_FOLDER)

  if (!fs.existsSync(folderName)) {
    throw new Error(`Could not find base folder at ${folderName}`)
  }

  const filename = path.join(folderName, constants.DEFAULT_PIPELINE)
  if (!fs.existsSync(filename)) {
    throw new Error(`Could not find pipeline at ${baseFolder}/${pipeline}`)
  }

  return  {
    pipeline: pipeline,
    baseFolder: baseFolder
  }
}

function assert(condition: any, msg?: string): asserts condition {
  if (!condition) throw new Error(msg)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function reset(): Promise<void> {

  cachedCspToken = null
}

run()
