/** Only this account sees the guided tour. Kept separate from step defs so Layout stays tiny. */
export const DEMO_TOUR_USER_ID = 'demo'

export function isDemoTourUser(id: string | null | undefined): boolean {
  return id === DEMO_TOUR_USER_ID
}
