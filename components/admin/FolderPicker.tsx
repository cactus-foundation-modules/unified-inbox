'use client'

import { useState, type ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Naming the folder an address is filed into, without having to know how the
// mail server spells it.
//
// Every one of these boxes used to be a plain text field, and a folder name is
// exactly the kind of thing nobody gets right first time: it is "Sent Messages"
// on iCloud, "Sent Items" at Microsoft, "INBOX.Suppliers" on half the shared
// hosts in Britain. Get it wrong and nothing complains - the folder is simply
// never read, which looks identical to an account that has gone quiet.
//
// So the list comes from the mail server itself, kept from the last time
// anybody asked, with a button to ask again. Typing a name by hand stays
// possible: a folder made this morning is not in a list taken last week, and
// nobody should have to press a button to save a form.
// ---------------------------------------------------------------------------

export type PickerFolder = {
  path: string
  name: string
  role: string | null
}

/** The sentinel option that turns the menu back into a text box. Not a folder
 *  name any server would return - the leading spaces are not legal in one. */
const TYPE_IT_IN = '  type it in  '

const MUTED = { color: 'var(--color-text-muted)' } as const

const ROLE_WORDS: Record<string, string> = {
  inbox: 'the main inbox',
  sent: 'sent mail',
  archive: 'the archive',
  junk: 'junk',
  trash: 'deleted',
  drafts: 'drafts',
}

function optionLabel(folder: PickerFolder): string {
  const word = folder.role ? ROLE_WORDS[folder.role] : undefined
  return word ? `${folder.path} - ${word}` : folder.path
}

export function FolderPicker({
  id,
  label,
  value,
  onChange,
  folders,
  checkedAt,
  connectionChosen,
  refreshing,
  onRefresh,
  blankLabel,
  placeholder,
}: {
  id: string
  label: ReactNode
  value: string
  onChange: (value: string) => void
  /** What the mail server last said it had, or null if nobody has ever asked. */
  folders: PickerFolder[] | null
  checkedAt: string | null
  /** False while no mail account is chosen, which is a perfectly good answer -
   *  an address can exist here without any mailbox being collected for it. */
  connectionChosen: boolean
  refreshing: boolean
  onRefresh: () => void
  /** The wording of the empty choice, for the boxes where "none" is allowed.
   *  Omitted, the box has no empty choice and a folder must be named. */
  blankLabel?: string
  placeholder?: string
}) {
  const [typing, setTyping] = useState(false)
  const known = folders ?? []
  const listed = known.some((f) => f.path === value)
  // A folder typed in before the list was ever fetched, or one since renamed,
  // stays visible as text rather than being quietly swapped for whatever
  // happens to be first in the menu.
  const asText = typing || known.length === 0 || (value !== '' && !listed)

  function backToTheList() {
    // Only ever called with a list to go back to, but the value showing may not
    // be in it, and a select whose value matches no option renders as its first
    // one - which would change the setting without anybody touching it.
    if (!known.some((f) => f.path === value)) {
      onChange(blankLabel !== undefined ? '' : known[0]?.path ?? '')
    }
    setTyping(false)
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 14rem', minWidth: 0 }}>
          {asText ? (
            <input
              id={id}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
            />
          ) : (
            <select
              id={id}
              value={value}
              onChange={(e) => {
                if (e.target.value === TYPE_IT_IN) setTyping(true)
                else onChange(e.target.value)
              }}
            >
              {blankLabel !== undefined && <option value="">{blankLabel}</option>}
              {known.map((folder) => (
                <option key={folder.path} value={folder.path}>{optionLabel(folder)}</option>
              ))}
              <option value={TYPE_IT_IN}>Type a folder name myself&hellip;</option>
            </select>
          )}
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!connectionChosen || refreshing}
          onClick={onRefresh}
          title={connectionChosen
            ? 'Ask the mail server which folders this account has'
            : 'Choose a mail account first'}
        >
          {refreshing ? 'Updating…' : 'Update folders'}
        </button>
      </div>
      <div style={{ ...MUTED, fontSize: '0.8125rem', marginTop: '0.25rem' }}>
        <FolderHint
          connectionChosen={connectionChosen}
          folders={folders}
          checkedAt={checkedAt}
          asText={asText}
        />
        {asText && known.length > 0 && (
          <>
            {' '}
            <button
              type="button"
              className="btn btn-link btn-sm"
              style={{ padding: 0, verticalAlign: 'baseline' }}
              onClick={backToTheList}
            >
              Choose from the list instead
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** One sentence about where the menu came from, or why there is not one. Split
 *  out because the four cases read far worse as nested ternaries in the middle
 *  of the markup. */
function FolderHint({ connectionChosen, folders, checkedAt, asText }: {
  connectionChosen: boolean
  folders: PickerFolder[] | null
  checkedAt: string | null
  asText: boolean
}) {
  if (!connectionChosen) {
    return <>Choose a mail account above and its folders can be listed here.</>
  }
  if (folders === null) {
    return <>Press Update folders and this account&rsquo;s folders will be listed for you.</>
  }
  if (folders.length === 0) {
    return <>That account listed no folders at all. Update folders asks it again.</>
  }
  const when = checkedAt
    ? ` as they were on ${new Date(checkedAt).toLocaleString('en-GB')}`
    : ''
  return asText
    ? <>{folders.length} folder{folders.length === 1 ? '' : 's'} known on this account{when}.</>
    : <>Listed from your mail server{when}. Update folders if you have made a new one since.</>
}
