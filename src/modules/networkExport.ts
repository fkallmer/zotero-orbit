/**
 * The Zotero side of the network exports: a file picker, a write, and a
 * browser launch. Every format and URL is built in networkExport.core.ts.
 */

import { getString } from '../utils/locale'

import {
  gapsToCsv,
  gapsToRis,
  incitefulUrl,
  localCitationNetworkUrl,
  toGraphml,
  toVosviewerJson,
} from './networkExport.core'

import type { FluentMessageId } from '../../typings/i10n'
import type { CollectionNetwork } from './collectionTypes'

export interface ExportAction {
  id: string
  l10n: FluentMessageId
  run: (win: Window) => Promise<void>
}

/**
 * Ask where to save, then write `text` there as UTF-8.
 *
 * @param suggestion the proposed file name
 * @param filter `[label, pattern]`, for example `['CSV (*.csv)', '*.csv']`
 * @returns false when the picker was cancelled
 */
export async function saveText(
  win: Window,
  suggestion: string,
  filter: [string, string],
  text: string,
): Promise<boolean> {
  const path = await new ztoolkit.FilePicker(filter[0], 'save', [filter], suggestion, win).open()
  if (!path) return false
  await Zotero.File.putContentsAsync(path, text)
  return true
}

function fileName(net: CollectionNetwork, suffix: string, extension: string): string {
  const base = Zotero.File.getValidFileName(net.scope.name.trim() || 'Orbit')
  return `${base} ${suffix}.${extension}`
}

function saveAction(
  id: string,
  l10n: FluentMessageId,
  filterLabel: FluentMessageId,
  extension: string,
  suffix: string,
  net: CollectionNetwork,
  render: () => string,
): ExportAction {
  return {
    id,
    l10n,
    run: async (win) => {
      const pattern = `*.${extension}`
      await saveText(
        win,
        fileName(net, suffix, extension),
        [`${getString(filterLabel)} (${pattern})`, pattern],
        render(),
      )
    },
  }
}

/**
 * What the network can be exported as or opened in. The two links are left
 * out when no seed has a DOI to carry.
 */
export function exportActions(net: CollectionNetwork): ExportAction[] {
  const actions: ExportAction[] = [
    saveAction('vosviewer', 'export-vosviewer', 'export-filter-vosviewer', 'json', 'VOSviewer', net, () =>
      toVosviewerJson(net),
    ),
    saveAction('graphml', 'export-graphml', 'export-filter-graphml', 'graphml', 'network', net, () => toGraphml(net)),
    saveAction('gaps-csv', 'export-gaps-csv', 'export-filter-csv', 'csv', 'gaps', net, () => gapsToCsv(net)),
    saveAction('gaps-ris', 'export-gaps-ris', 'export-filter-ris', 'ris', 'gaps', net, () => gapsToRis(net.gaps)),
  ]

  const dois = net.seeds.map((seed) => seed.doi)
  const lcn = localCitationNetworkUrl(dois, net.scope.name)
  if (lcn !== null) actions.push(linkAction('open-lcn', 'export-open-lcn', lcn))
  const inciteful = incitefulUrl(dois)
  if (inciteful !== null) actions.push(linkAction('open-inciteful', 'export-open-inciteful', inciteful))

  return actions
}

function linkAction(id: string, l10n: FluentMessageId, url: string): ExportAction {
  return {
    id,
    l10n,
    run: () => {
      Zotero.launchURL(url)
      return Promise.resolve()
    },
  }
}
