<template>
  <main class="app-shell px-3 py-3 font-sans antialiased sm:px-4">
    <div class="mx-auto grid max-w-[1080px] gap-3.5">
      <section class="theme-panel grid gap-3.5 rounded-[28px] border p-4 backdrop-blur-[10px]">
        <div class="flex flex-wrap items-start justify-between gap-3.5 max-md:flex-col max-md:items-stretch">
          <div>
            <h1 class="m-0 text-[clamp(28px,4vw,40px)] font-extrabold leading-none tracking-[-0.04em]">
              Irrigation
            </h1>
            <p class="theme-text-muted mt-2 max-w-2xl text-[15px] leading-[1.45]">
              Start, stop, and manage irrigation schedules for each valve.
            </p>
          </div>

          <div class="flex flex-wrap items-center justify-end gap-2.5 max-md:w-full">
            <div class="theme-button-secondary inline-flex min-h-[46px] items-center justify-center gap-2.5 rounded-full border px-3.5 py-2.5 text-sm font-bold max-md:w-full">
              <span
                class="h-2.5 w-2.5 rounded-full"
                :class="socketConnected ? 'bg-[#2f7d4b]' : 'bg-[#b64b4b]'"
              />
              <span>{{ socketConnected ? 'Connected' : 'Disconnected' }}</span>
            </div>

            <button
              type="button"
              class="theme-button-secondary inline-flex min-h-[46px] items-center justify-center gap-2.5 rounded-full border px-3.5 py-2.5 text-sm font-bold transition hover:-translate-y-[1px] max-md:w-full"
              @click="openRawEditor"
            >
              Edit Database
            </button>

            <button
              type="button"
              class="theme-button-secondary inline-flex min-h-[46px] items-center justify-center gap-2.5 rounded-full border px-3.5 py-2.5 text-sm font-bold transition hover:-translate-y-[1px] max-md:w-full"
              @click="addManualGateway"
            >
              + Gateway IP
            </button>

            <button
              type="button"
              class="inline-flex min-h-[46px] items-center justify-center gap-2.5 rounded-full border px-3.5 py-2.5 text-sm font-bold transition hover:-translate-y-[1px] disabled:cursor-wait disabled:opacity-60 max-md:w-full"
              :class="pairingButtonClass"
              :disabled="pairingBusy"
              @click="togglePairing"
            >
              {{ pairingButtonText }}
            </button>
          </div>
        </div>

        <div class="theme-text-muted -mt-1 text-[13px] leading-[1.4]">
          {{ pairingNote }}
        </div>

        <div class="grid gap-2.5 md:grid-cols-3">
          <div
            v-for="item in summaryCards"
            :key="item.label"
            class="theme-soft rounded-[22px] border px-4 py-3.5"
          >
            <span class="theme-text-muted mb-2 block text-[13px]">{{ item.label }}</span>
            <strong class="block text-[28px] leading-none tracking-[-0.04em]">{{ item.value }}</strong>
          </div>
        </div>
      </section>

      <!-- Gateways Section -->
      <section v-if="gateways.length > 0" class="grid gap-3.5">
        <article
          v-for="gw in gateways"
          :key="gw.id"
          class="theme-card grid gap-4 rounded-[28px] border p-4"
        >
          <div class="flex flex-wrap items-start justify-between gap-3 max-md:flex-col max-md:items-stretch">
            <div>
              <strong class="block text-[22px] leading-[1.1] tracking-[-0.03em]">
                Gateway {{ gw.id }}
              </strong>
              <div class="theme-text-muted mt-1.5 text-sm leading-[1.4]">
                {{ gw.model || 'Unknown Model' }} · {{ gw.ip }}:{{ gw.port }}
              </div>
            </div>
            
            <div class="flex flex-wrap gap-2 max-md:w-full">
              <div
                class="inline-flex items-center gap-2 rounded-full border px-3 py-2 text-[13px] font-bold max-md:flex-1 max-md:justify-center"
                :class="gw.isConnected ? 'theme-chip-success' : 'theme-chip-danger'"
              >
                <span
                  class="h-2.5 w-2.5 rounded-full"
                  :class="gw.isConnected ? 'bg-[#2f7d4b]' : 'bg-[#b64b4b]'"
                />
                {{ gw.isConnected ? 'Connected' : 'Offline' }}
              </div>
              <div class="inline-flex items-center rounded-full border px-3 py-2 text-[13px] font-bold theme-chip-neutral max-md:flex-1 max-md:justify-center">
                FW: {{ gw.version || 'Unknown' }}
              </div>
              <button
                v-if="gw.otaUpdate && gw.otaUpdate.hasUpdate"
                @click="triggerOtaUpdate(gw.id)"
                class="theme-button-primary inline-flex items-center rounded-full border px-3 py-2 text-[13px] font-bold max-md:flex-1 max-md:justify-center transition hover:-translate-y-[1px]"
              >
                Update to {{ gw.otaUpdate.latestVersion }}
              </button>
              <button
                v-if="gw.id.startsWith('manual-')"
                @click="removeGateway(gw.id)"
                class="theme-button-danger inline-flex items-center rounded-full border px-3 py-2 text-[13px] font-bold max-md:flex-1 max-md:justify-center transition hover:-translate-y-[1px]"
              >
                Delete
              </button>
            </div>
          </div>
        </article>
      </section>

       <!-- Diagnostic Logs Section -->
       <section v-if="diagnosticLogs.length > 0" class="grid gap-3.5">
          <div class="theme-card px-4 py-4 shadow-none rounded-[28px] border">
            <strong class="block">Unknown Devices Detected</strong>
            <div class="theme-text-muted mt-1 text-sm">
              We've captured logs for {{ diagnosticLogs.length }} unsupported model(s).
            </div>
            <div class="mt-3 grid gap-2">
              <div
                v-for="log in diagnosticLogs"
                :key="log.valveId"
                class="grid gap-2 rounded-xl border px-3 py-2"
              >
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2">
                    <span class="theme-chip-neutral min-w-[60px] rounded-full px-2 py-1 text-[11px] font-bold">
                      ID: {{ log.valveId }}
                    </span>
                    <span class="theme-text-muted text-xs">
                      {{ formatTimestamp(log.timestamp) }}
                      <span v-if="log.packetCount > 1"> · {{ log.packetCount }} Packets</span>
                    </span>
                  </div>
                  <button
                    @click="downloadJoinLog(log.valveId)"
                    class="theme-button-secondary min-h-[32px] rounded-full border px-3 text-[11px] font-bold transition hover:-translate-y-[1px]"
                  >
                    Download Log
                  </button>
                </div>
                <div class="theme-text-muted text-xs">
                  Gateway: {{ log.gatewayId }} · RSSI: {{ log.rssi }}dBm
                </div>
              </div>
            </div>
          </div>
       </section>

      <section class="grid gap-3.5">
        <div
          v-if="sortedDevices.length === 0"
          class="theme-card px-6 py-10 text-center shadow-none rounded-[28px] border"
        >
          <strong class="block">No devices found yet.</strong>
          <div class="theme-text-muted mt-1 text-xs">
            As soon as the hub detects devices, they will appear here automatically.
          </div>
        </div>

        <article
          v-for="device in sortedDevices"
          :key="device.valveId"
          class="theme-card grid gap-4 rounded-[28px] border p-4"
        >
          <div class="flex flex-wrap items-start justify-between gap-3 max-md:flex-col max-md:items-stretch">
            <div>
              <strong class="block text-[22px] leading-[1.1] tracking-[-0.03em]">
                {{ device.model || 'Irrigation device' }}
              </strong>
              <div class="theme-text-muted mt-1.5 text-sm leading-[1.4]">
                {{ channelCount(device) }} valve{{ channelCount(device) === 1 ? '' : 's' }}
              </div>
            </div>

            <div class="flex flex-wrap gap-2 max-md:w-full">
              <div
                class="inline-flex items-center gap-2 rounded-full border px-3 py-2 text-[13px] font-bold max-md:flex-1 max-md:justify-center"
                :class="device.isOnline ? 'theme-chip-success' : 'theme-chip-danger'"
              >
                <span
                  class="h-2.5 w-2.5 rounded-full"
                  :class="device.isOnline ? 'bg-[#2f7d4b]' : 'bg-[#b64b4b]'"
                />
                {{ device.isOnline ? 'Online' : 'Offline' }}
              </div>

              <div
                class="inline-flex items-center rounded-full border px-3 py-2 text-[13px] font-bold max-md:flex-1 max-md:justify-center"
                :class="isBatteryLow(device) ? 'theme-chip-warning' : 'theme-chip-neutral'"
              >
                Battery {{ device.battery || 'Unknown' }}
              </div>

              <button
                type="button"
                class="theme-button-danger inline-flex items-center rounded-full border px-3 py-2 text-[13px] font-bold max-md:flex-1 max-md:justify-center transition hover:-translate-y-[1px]"
                @click="removeDevice(device.valveId)"
              >
                Delete
              </button>
            </div>
          </div>

          <div class="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))] max-md:grid-cols-1">
            <section
              v-for="[channelId, channel] in sortedChannels(device)"
              :key="`${device.valveId}-${channelId}`"
              class="theme-subtle grid min-w-0 gap-3.5 rounded-[22px] border p-[15px]"
            >
              <div class="flex items-start justify-between gap-3 max-md:flex-col max-md:items-stretch">
                <div class="min-w-0">
                  <strong class="block text-lg leading-[1.1] tracking-[-0.02em]">Valve {{ channelId }}</strong>
                  <span class="theme-text-muted mt-1 block text-[13px] leading-[1.4]">
                    {{ channel.source || 'Manual' }}
                  </span>
                </div>

                <div class="grid grid-cols-2 gap-2 max-md:w-full">
                  <button
                    type="button"
                    class="theme-button-secondary min-h-[42px] rounded-full border px-3 text-[13px] font-bold transition hover:-translate-y-[1px]"
                    @click="openSheet('plan', device.valveId, channelId)"
                  >
                    Schedules
                  </button>
                  <button
                    type="button"
                    class="theme-button-secondary min-h-[42px] rounded-full border px-3 text-[13px] font-bold transition hover:-translate-y-[1px]"
                    @click="openSheet('config', device.valveId, channelId)"
                  >
                    Settings
                  </button>
                </div>
              </div>

              <div class="flex flex-wrap items-center justify-between gap-3">
                <div
                  class="shrink-0 rounded-full px-2.5 py-2 text-xs font-extrabold tracking-[0.02em]"
                  :class="isChannelRunning(channel) ? 'theme-chip-success' : 'theme-chip-neutral'"
                >
                  {{ isChannelRunning(channel) ? 'Running' : 'Off' }}
                </div>
                <div class="theme-text-muted text-xs leading-[1.4]">
                  {{ scheduleCount(device.valveId, channelId) }} schedule{{ scheduleCount(device.valveId, channelId) === 1 ? '' : 's' }}
                  · Rain stop: {{ rainStopText(device.valveId, channelId) }}
                </div>
              </div>

              <div class="grid gap-1">
                <div class="[overflow-wrap:anywhere] text-[34px] font-extrabold leading-none tracking-[-0.05em] max-md:text-[30px]">
                  {{ formatDuration(getLiveRemaining(channel)) }}
                </div>
                <div class="theme-text-muted text-[13px]">remaining time</div>
              </div>

              <div class="grid gap-2 md:grid-cols-2 max-md:grid-cols-1">
                <div class="theme-soft rounded-2xl border px-3 py-2.5">
                  <span class="theme-text-muted mb-1 block text-xs">Default runtime</span>
                  <strong class="block text-sm leading-[1.3]">
                    {{ formatMinutes(getDefaultChannelConfig(device.valveId, channelId).defaultOpenMinutes) }}
                  </strong>
                </div>
                <div class="theme-soft rounded-2xl border px-3 py-2.5">
                  <span class="theme-text-muted mb-1 block text-xs">Next schedule</span>
                  <strong class="block text-sm leading-[1.3]">
                    {{ nextPlanLabel(device.valveId, channelId) }}
                  </strong>
                </div>
              </div>

              <div class="grid grid-cols-4 gap-2 max-[860px]:grid-cols-2">
                <button
                  v-for="minutes in PRESETS"
                  :key="minutes"
                  type="button"
                  class="min-h-[46px] rounded-full border px-2.5 text-[13px] font-bold transition"
                  :class="getInputMinutes(device.valveId, channelId) === minutes
                    ? 'theme-chip-success'
                    : 'theme-button-secondary'"
                  @click="setPreset(device.valveId, channelId, minutes)"
                >
                  {{ minutes }} min
                </button>
              </div>

              <div class="grid items-center gap-2.5 [grid-template-columns:minmax(0,112px)_minmax(0,1fr)_minmax(0,1fr)] max-[860px]:grid-cols-1">
                <label class="theme-input flex min-h-[46px] min-w-0 items-center gap-2 rounded-full border px-3.5">
                  <input
                    :value="getInputMinutes(device.valveId, channelId)"
                    type="number"
                    inputmode="numeric"
                    min="1"
                    step="1"
                    class="w-full min-w-0 appearance-none border-0 bg-transparent p-0 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    :aria-label="`Duration in minutes for valve ${channelId}`"
                    @input="setDurationInput(device.valveId, channelId, $event)"
                  />
                  <span class="theme-text-muted shrink-0 whitespace-nowrap text-[13px]">min</span>
                </label>

                <button
                  type="button"
                  class="theme-button-primary min-h-[46px] w-full rounded-full border px-3 py-2.5 text-sm font-bold transition hover:-translate-y-[1px] disabled:cursor-wait disabled:opacity-60"
                  :disabled="isPending(device.valveId, channelId, 'ON')"
                  @click="sendValve(device.valveId, channelId, 'ON')"
                >
                  {{ isPending(device.valveId, channelId, 'ON') ? 'Starting…' : 'Start' }}
                </button>

                <button
                  type="button"
                  class="theme-button-danger min-h-[46px] w-full rounded-full border px-3 py-2.5 text-sm font-bold transition hover:-translate-y-[1px] disabled:cursor-wait disabled:opacity-60"
                  :disabled="isPending(device.valveId, channelId, 'OFF')"
                  @click="sendValve(device.valveId, channelId, 'OFF')"
                >
                  {{ isPending(device.valveId, channelId, 'OFF') ? 'Stopping…' : 'Stop' }}
                </button>
              </div>
            </section>
          </div>
        </article>
      </section>
    </div>
  </main>

  <Teleport to="body">
    <div
      v-if="isSheetOpen"
      class="theme-overlay fixed inset-0 z-[1000] flex items-end justify-center p-3"
      aria-hidden="false"
      @click.self="requestCloseSheet"
    >
      <section
        role="dialog"
        aria-modal="true"
        :aria-labelledby="sheetTitleId"
        class="theme-modal grid max-h-[min(88vh,920px)] w-full max-w-[760px] gap-4 overflow-auto rounded-[28px] border p-[18px]"
      >
        <div class="mx-auto mb-0.5 h-[5px] w-[52px] rounded-full bg-[var(--border-soft)]" />

        <div class="flex items-start justify-between gap-3.5">
          <div>
            <strong :id="sheetTitleId" class="block text-[22px] leading-[1.1] tracking-[-0.03em]">
              {{ sheetTitle }}
            </strong>
            <span class="theme-text-muted mt-1.5 block text-sm leading-[1.4]">{{ sheetSubtitle }}</span>
          </div>

          <button
            type="button"
            class="theme-button-secondary flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full border text-lg"
            aria-label="Close"
            @click="requestCloseSheet"
          >
            ✕
          </button>
        </div>

        <template v-if="activeSheet === 'plan'">
          <div class="grid gap-3">
            <div class="grid gap-3">
              <div class="text-[15px] font-extrabold tracking-[-0.02em]">Existing schedules</div>
              <div class="grid gap-2.5">
                <div
                  v-if="currentSchedules.length === 0"
                  class="theme-subtle grid gap-2 rounded-[18px] border p-3"
                >
                  <div>
                    <strong>No schedules yet</strong>
                    <small class="theme-text-muted mt-1 block leading-[1.4]">
                      Create one or more schedules for this valve below.
                    </small>
                  </div>
                </div>

                <article
                  v-for="plan in currentSchedules"
                  :key="plan.id"
                  class="theme-subtle grid gap-2 rounded-[18px] border p-3"
                >
                  <div class="flex items-start justify-between gap-3 max-md:flex-col max-md:items-stretch">
                    <div>
                      <strong class="text-[15px] leading-[1.3]">
                        {{ plan.mode === 'mist' ? 'Misting' : 'Normal' }} · {{ plan.startTime }}
                      </strong>
                      <small class="theme-text-muted mt-1 block leading-[1.4]">
                        {{ describePlan(plan) }}
                      </small>
                    </div>

                    <button
                      type="button"
                      class="theme-button-danger min-h-9 shrink-0 rounded-full border px-3 text-sm font-bold"
                      @click="deletePlan(plan.id)"
                    >
                      Delete
                    </button>
                  </div>
                </article>
              </div>
            </div>

            <div class="grid gap-3">
              <div class="text-[15px] font-extrabold tracking-[-0.02em]">Create schedule</div>

              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="min-h-10 rounded-full border px-3 text-sm font-bold"
                  :class="planDraft.mode === 'normal' ? 'theme-chip-success' : 'theme-button-secondary'"
                  @click="planDraft.mode = 'normal'"
                >
                  Normal
                </button>
                <button
                  type="button"
                  class="min-h-10 rounded-full border px-3 text-sm font-bold"
                  :class="planDraft.mode === 'mist' ? 'theme-chip-success' : 'theme-button-secondary'"
                  @click="planDraft.mode = 'mist'"
                >
                  Misting
                </button>
              </div>

              <div class="grid gap-2.5 md:grid-cols-2">
                <div class="theme-soft grid min-w-0 gap-1.5 rounded-[18px] border px-3.5 py-3">
                  <label for="planStartTime" class="theme-text-muted text-xs font-bold">Start time</label>
                  <input
                    id="planStartTime"
                    v-model="planForm.startTime"
                    class="theme-input min-h-11 w-full rounded-xl border px-3"
                    type="time"
                  />
                </div>

                <div class="theme-soft grid min-w-0 gap-1.5 rounded-[18px] border px-3.5 py-3">
                  <label for="planDuration" class="theme-text-muted text-xs font-bold">Total duration</label>
                  <input
                    id="planDuration"
                    v-model.number="planForm.durationMinutes"
                    class="theme-input min-h-11 w-full rounded-xl border px-3"
                    type="number"
                    min="1"
                    max="1440"
                    step="1"
                    inputmode="numeric"
                  />
                </div>
              </div>

              <div v-if="planDraft.mode === 'mist'" class="grid gap-2.5 xl:grid-cols-3 md:grid-cols-3 max-md:grid-cols-1">
                <div class="theme-soft grid min-w-0 gap-1.5 rounded-[18px] border px-3.5 py-3">
                  <label for="planMistOn" class="theme-text-muted text-xs font-bold">Run time</label>
                  <input
                    id="planMistOn"
                    v-model.number="planForm.mistOnSeconds"
                    class="theme-input min-h-11 w-full rounded-xl border px-3"
                    type="number"
                    min="1"
                    max="3600"
                    step="1"
                    inputmode="numeric"
                  />
                </div>

                <div class="theme-soft grid min-w-0 gap-1.5 rounded-[18px] border px-3.5 py-3">
                  <label for="planMistOff" class="theme-text-muted text-xs font-bold">Interval</label>
                  <input
                    id="planMistOff"
                    v-model.number="planForm.mistOffSeconds"
                    class="theme-input min-h-11 w-full rounded-xl border px-3"
                    type="number"
                    min="1"
                    max="3600"
                    step="1"
                    inputmode="numeric"
                  />
                </div>

                <div class="theme-soft grid min-w-0 gap-1.5 rounded-[18px] border px-3.5 py-3">
                  <label class="theme-text-muted text-xs font-bold">Note</label>
                  <div class="theme-text-muted text-xs leading-[1.4]">
                    Run time and interval can each be at most 1 hour.
                  </div>
                </div>
              </div>

              <div class="grid gap-3">
                <div class="text-[15px] font-extrabold tracking-[-0.02em]">Repeat</div>
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="option in repeatOptions"
                    :key="option.value"
                    type="button"
                    class="min-h-10 rounded-full border px-3 text-sm font-bold"
                    :class="planDraft.repeat === option.value ? 'theme-chip-success' : 'theme-button-secondary'"
                    @click="selectRepeat(option.value)"
                  >
                    {{ option.label }}
                  </button>
                </div>

                <div v-if="planDraft.repeat === 'custom'" class="flex flex-wrap gap-2">
                  <button
                    v-for="day in weekdays"
                    :key="day.value"
                    type="button"
                    class="min-h-10 rounded-full border px-3 text-sm font-bold"
                    :class="planDraft.weekdays.includes(day.value) ? 'theme-chip-success' : 'theme-button-secondary'"
                    @click="toggleWeekday(day.value)"
                  >
                    {{ day.label }}
                  </button>
                </div>
              </div>

              <button
                type="button"
                class="theme-button-secondary min-h-12 rounded-full border px-4 font-extrabold"
                @click="addPlanToEditor"
              >
                Add schedule to list
              </button>
            </div>
          </div>

          <div class="grid gap-2.5 md:grid-cols-2">
            <button
              type="button"
              class="theme-button-secondary min-h-12 rounded-full border px-4 font-extrabold"
              @click="cancelPlanEditing"
            >
              Cancel
            </button>
            <button
              type="button"
              class="theme-button-primary min-h-12 rounded-full border px-4 font-extrabold"
              @click="saveAllPlans(true)"
            >
              Save changes
            </button>
          </div>
        </template>

        <template v-else-if="activeSheet === 'config'">
          <div class="grid gap-4">
            <div class="grid gap-3">
              <div class="text-[15px] font-extrabold tracking-[-0.02em]">Default runtime</div>
              <div class="grid gap-2.5 md:grid-cols-2">
                <div class="theme-soft grid min-w-0 gap-1.5 rounded-[18px] border px-3.5 py-3">
                  <label for="defaultOpenMinutes" class="theme-text-muted text-xs font-bold">
                    Duration when pressing the device button
                  </label>
                  <input
                    id="defaultOpenMinutes"
                    v-model.number="configDraft.defaultOpenMinutes"
                    class="theme-input min-h-11 w-full rounded-xl border px-3"
                    type="number"
                    min="1"
                    max="1440"
                    step="1"
                    inputmode="numeric"
                  />
                </div>

                <div class="theme-soft grid min-w-0 gap-1.5 rounded-[18px] border px-3.5 py-3">
                  <label class="theme-text-muted text-xs font-bold">Note</label>
                  <div class="theme-text-muted text-xs leading-[1.4]">
                    This duration is used when the valve is started directly on the device.
                  </div>
                </div>
              </div>
            </div>

            <div class="grid gap-3">
              <div class="text-[15px] font-extrabold tracking-[-0.02em]">Rain stop</div>
              <div class="grid gap-2.5 md:grid-cols-2">
                <div class="theme-soft grid min-w-0 gap-1.5 rounded-[18px] border px-3.5 py-3">
                  <label for="rainStopUntil" class="theme-text-muted text-xs font-bold">Pause until</label>
                  <input
                    id="rainStopUntil"
                    v-model="configDraft.rainStopUntil"
                    class="theme-input min-h-11 w-full rounded-xl border px-3"
                    type="datetime-local"
                  />
                </div>

                <div class="theme-soft grid min-w-0 gap-1.5 rounded-[18px] border px-3.5 py-3">
                  <label class="theme-text-muted text-xs font-bold">Status</label>
                  <div class="theme-text-muted text-xs leading-[1.4]">{{ rainStopStatusText }}</div>
                </div>
              </div>
            </div>
          </div>

          <div class="grid gap-2.5 md:grid-cols-2">
            <button
              type="button"
              class="theme-button-danger min-h-12 rounded-full border px-4 font-extrabold"
              @click="clearRainStop"
            >
              Clear rain stop
            </button>
            <button
              type="button"
              class="theme-button-primary min-h-12 rounded-full border px-4 font-extrabold"
              @click="saveChannelConfig"
            >
              Save settings
            </button>
          </div>
        </template>

        <template v-else-if="activeSheet === 'rawEdit'">
          <div class="grid gap-4">
            <div class="grid gap-3">
              <div class="text-[15px] font-extrabold tracking-[-0.02em]">Raw JSON Data</div>
              <div class="theme-soft grid min-w-0 gap-1.5 rounded-[18px] border px-3.5 py-3">
                <textarea
                  v-model="rawJsonContent"
                  class="theme-input min-h-[300px] w-full rounded-xl border px-3 py-3 font-mono text-[13px] leading-relaxed resize-y"
                  placeholder="Loading..."
                  spellcheck="false"
                ></textarea>
              </div>
              <div v-if="rawJsonError" class="theme-text-danger text-[13px] font-bold">
                {{ rawJsonError }}
              </div>
              <div class="theme-text-muted text-[13px] leading-[1.4]">
                <strong>Warning:</strong> Modifying the raw database can corrupt your configuration. Ensure the JSON is valid before saving. Saving will immediately restart the system.
              </div>
            </div>
          </div>

          <div class="grid gap-2.5 md:grid-cols-2 mt-2">
            <button
              type="button"
              class="theme-button-secondary min-h-12 rounded-full border px-4 font-extrabold"
              @click="requestCloseSheet"
            >
              Cancel
            </button>
            <button
              type="button"
              class="theme-button-primary min-h-12 rounded-full border px-4 font-extrabold disabled:cursor-wait disabled:opacity-60"
              :disabled="isRestarting"
              @click="saveRawJson"
            >
              {{ isRestarting ? 'Restarting...' : 'Save & Restart' }}
            </button>
          </div>
        </template>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { createSocket } from './socket'

let socket = null
let intervalId = null
let heartbeatIntervalId = null
let reconnectTimerId = null
let heartbeatFallbackTimerId = null
let themeMediaQuery = null
let heartbeatInFlight = false
let missedHeartbeats = 0

const PRESETS = [5, 10, 30, 60]
const sheetTitleId = 'sheetTitle'

const HEARTBEAT_EVENT = 'app:ping'
const HEARTBEAT_INTERVAL = 5000
const HEARTBEAT_TIMEOUT = 2500
const HEARTBEAT_FAIL_THRESHOLD = 2

const pairingMode = ref(false)
const pairingBusy = ref(false)
const pairingKnown = ref(false)
const socketConnected = ref(false)
const now = ref(Date.now())
const activeSheet = ref(null)
const activeChannel = ref(null)

const devicesById = ref({})
const pending = ref(new Set())
const durationInputs = ref({})
const channelConfigs = ref({})
const planEditorSchedules = ref([])
const planDirty = ref(false)

const gateways = ref([])
const diagnosticLogs = ref([])

const rawJsonContent = ref('')
const rawJsonError = ref('')
const isRestarting = ref(false)

const planDraft = reactive({
  mode: 'normal',
  repeat: 'daily',
  weekdays: [1, 3, 5],
})

const planForm = reactive({
  startTime: '06:00',
  durationMinutes: 10,
  mistOnSeconds: 10,
  mistOffSeconds: 30,
})

const configDraft = reactive({
  defaultOpenMinutes: 10,
  rainStopUntil: '',
})

const repeatOptions = [
  { value: 'daily', label: 'Every day' },
  { value: 'odd', label: 'Odd dates' },
  { value: 'even', label: 'Even dates' },
  { value: 'custom', label: 'Custom' },
]

const weekdays = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
]

const sortedDevices = computed(() => {
  return Object.values(devicesById.value).sort((a, b) => Number(a.valveId) - Number(b.valveId))
})

const onlineCount = computed(() => sortedDevices.value.filter((device) => device.isOnline).length)

const runningCount = computed(() => {
  return sortedDevices.value.reduce((sum, device) => {
    return sum + sortedChannels(device).filter(([, channel]) => isChannelRunning(channel)).length
  }, 0)
})

const summaryCards = computed(() => [
  { label: 'Devices', value: sortedDevices.value.length },
  { label: 'Online', value: onlineCount.value },
  { label: 'Currently running', value: runningCount.value },
])

const pairingButtonText = computed(() => {
  if (!pairingKnown.value) return pairingBusy.value ? 'Loading…' : 'Pairing'
  if (pairingBusy.value) return 'Saving…'
  return pairingMode.value ? 'Pairing on' : 'Pairing off'
})

const pairingButtonClass = computed(() => {
  if (!pairingKnown.value) return 'theme-button-secondary'
  return pairingMode.value ? 'theme-button-primary' : 'theme-button-secondary'
})

const pairingNote = computed(() => {
  if (!pairingKnown.value) return 'Loading pairing status.'
  return pairingMode.value
    ? 'Pairing is active. New devices can now be discovered and added.'
    : 'New devices can only be added when pairing is enabled.'
})

const isSheetOpen = computed(() => {
  if (activeSheet.value === 'rawEdit') return true
  return Boolean(activeSheet.value && activeChannel.value)
})

const activeDevice = computed(() => {
  if (!activeChannel.value) return null
  return devicesById.value[activeChannel.value.deviceId] || null
})

const sheetTitle = computed(() => {
  if (activeSheet.value === 'rawEdit') return 'Database Editor'
  if (!activeChannel.value) return 'Schedule'
  const base = `Valve ${activeChannel.value.channelId}`
  return activeSheet.value === 'plan' ? `${base} · Schedules` : `${base} · Settings`
})

const sheetSubtitle = computed(() => {
  if (activeSheet.value === 'rawEdit') return 'Edit devices.json manually'
  if (!activeChannel.value) return ''
  return `${activeDevice.value?.model || 'Irrigation device'} · ID ${activeChannel.value.deviceId}`
})

const currentSchedules = computed(() => planEditorSchedules.value)

const rainStopStatusText = computed(() => {
  return configDraft.rainStopUntil
    ? `Active until ${formatDateTimeLocal(configDraft.rainStopUntil)}`
    : 'No rain stop active.'
})

function syncTheme(event) {
  const dark = typeof event?.matches === 'boolean'
    ? event.matches
    : window.matchMedia('(prefers-color-scheme: dark)').matches

  document.documentElement.classList.toggle('dark', dark)
}

function channelKey(deviceId, channelId) {
  return `${deviceId}:${channelId}`
}

function pendingKey(deviceId, channelId, action) {
  return `${deviceId}:${channelId}:${action}`
}

function clearReconnectTimer() {
  if (reconnectTimerId) {
    window.clearTimeout(reconnectTimerId)
    reconnectTimerId = null
  }
}

function clearHeartbeatFallback() {
  if (heartbeatFallbackTimerId) {
    window.clearTimeout(heartbeatFallbackTimerId)
    heartbeatFallbackTimerId = null
  }
}

function resetHeartbeatState() {
  heartbeatInFlight = false
  missedHeartbeats = 0
  clearHeartbeatFallback()
}

function scheduleSilentReconnect() {
  // Socket.io's built-in reconnection handles all reconnect logic.
  // We intentionally do NOT call socket.disconnect()/connect() here,
  // because that interrupts Socket.io's own exponential backoff and
  // causes reconnect attempts to stack up when the backend is offline.
}

function handleHeartbeatSuccess() {
  heartbeatInFlight = false
  missedHeartbeats = 0
  clearHeartbeatFallback()
  socketConnected.value = true
}

function handleHeartbeatFailure() {
  heartbeatInFlight = false
  clearHeartbeatFallback()
  missedHeartbeats += 1

  if (missedHeartbeats >= HEARTBEAT_FAIL_THRESHOLD) {
    socketConnected.value = false
    // We do NOT call scheduleSilentReconnect() here anymore.
    // Socket.io reconnects on its own. We only update the UI status.
  }
}

function sendHeartbeat() {
  if (!socket) return

  if (!socket.connected) {
    handleHeartbeatFailure()
    return
  }

  if (heartbeatInFlight) {
    handleHeartbeatFailure()
    return
  }

  heartbeatInFlight = true

  try {
    if (typeof socket.timeout === 'function') {
      socket.timeout(HEARTBEAT_TIMEOUT).emit(HEARTBEAT_EVENT, { ts: Date.now() }, (err) => {
        if (err) {
          handleHeartbeatFailure()
          return
        }

        handleHeartbeatSuccess()
      })
      return
    }

    clearHeartbeatFallback()
    heartbeatFallbackTimerId = window.setTimeout(() => {
      if (heartbeatInFlight) {
        handleHeartbeatFailure()
      }
    }, HEARTBEAT_TIMEOUT)

    socket.emit(HEARTBEAT_EVENT, { ts: Date.now() }, () => {
      handleHeartbeatSuccess()
    })
  } catch {
    handleHeartbeatFailure()
  }
}

function startHeartbeat() {
  stopHeartbeat()
  heartbeatIntervalId = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL)
  sendHeartbeat()
}

function stopHeartbeat() {
  if (heartbeatIntervalId) {
    window.clearInterval(heartbeatIntervalId)
    heartbeatIntervalId = null
  }

  resetHeartbeatState()
}

function getDefaultChannelConfig(deviceId, channelId) {
  const key = channelKey(deviceId, channelId)

  if (!channelConfigs.value[key]) {
    channelConfigs.value[key] = {
      defaultOpenMinutes: 10,
      rainStopUntil: '',
      schedules: [],
    }
  }

  return channelConfigs.value[key]
}

function normalizeSchedule(item, index) {
  return {
    id: item.id || `srv-${index}-${Date.now()}`,
    ...item,
  }
}

function cloneSchedules(items = []) {
  return items.map((item, index) => ({
    ...normalizeSchedule(item, index),
    weekdays: Array.isArray(item.weekdays) ? [...item.weekdays] : [],
  }))
}

function mergeChannelConfigFromDevice(device) {
  for (const [channelId] of Object.entries(device.channels || {})) {
    const config = getDefaultChannelConfig(device.valveId, channelId)
    const source = device.channelConfig?.[channelId] || device.channels?.[channelId]?.config || null

    if (!source) continue

    if (Number.isFinite(Number(source.defaultOpenMinutes))) {
      config.defaultOpenMinutes = Number(source.defaultOpenMinutes)
    } else if (Number.isFinite(Number(source.defaultOpenSeconds))) {
      config.defaultOpenMinutes = Math.max(1, Math.round(Number(source.defaultOpenSeconds) / 60))
    }

    if (typeof source.rainStopUntil === 'string') {
      config.rainStopUntil = source.rainStopUntil
    }

    if (Array.isArray(source.schedules)) {
      config.schedules = source.schedules.map(normalizeSchedule)
    }
  }
}

function getClientLiveRemaining(channel) {
  if (!channel || !channel.isRunning) return 0

  const base = Number(channel._snapshotRemaining ?? channel.remainingLive ?? 0)
  const elapsed = Math.floor((Date.now() - (channel._snapshotAt || Date.now())) / 1000)
  return Math.max(0, base - elapsed)
}

function mergeDeviceUpdate(device, targetObject = null) {
  const currentStore = targetObject || devicesById.value
  const previous = currentStore[device.valveId] || null
  const nextChannels = {}

  for (const [channelId, channel] of Object.entries(device.channels || {})) {
    const prev = previous?.channels?.[channelId]

    const syncChanged =
      !prev ||
      prev.lastSync !== channel.lastSync ||
      prev.status !== channel.status ||
      prev.isRunning !== channel.isRunning ||
      Number(prev.targetRuntime || 0) !== Number(channel.targetRuntime || 0)

    nextChannels[channelId] = {
      ...prev,
      ...channel,
      _snapshotRemaining: syncChanged
        ? Number(channel.remainingLive ?? channel.remaining ?? 0)
        : getClientLiveRemaining(prev),
      _snapshotAt: syncChanged ? Date.now() : prev?._snapshotAt || Date.now(),
    }
  }

  const updatedDevice = {
    ...previous,
    ...device,
    channels: nextChannels,
    _updatedAt: Date.now(),
  }

  if (targetObject) {
    targetObject[device.valveId] = updatedDevice
  } else {
    devicesById.value = {
      ...devicesById.value,
      [device.valveId]: updatedDevice,
    }
  }

  mergeChannelConfigFromDevice(device)
}

function setInitialDevices(devices) {
  const incomingDevices = Array.isArray(devices) ? devices : []
  const incomingIds = incomingDevices.map(d => String(d.valveId))

  // Wir bauen das komplette neue Objekt im Speicher auf,
  // um Vue nicht mehrmals hintereinander rendern zu lassen.
  const nextStore = {}
  
  // 1. Alte Geräte übernehmen, die noch existieren
  for (const [id, device] of Object.entries(devicesById.value)) {
    if (incomingIds.includes(String(id))) {
      nextStore[id] = device
    }
  }

  // 2. Alle neuen Updates in dieses Zwischenobjekt einarbeiten
  incomingDevices.forEach(device => {
    mergeDeviceUpdate(device, nextStore)
  })

  // 3. Erst ganz am Ende das reaktive Objekt überschreiben (ein einziger Render-Zyklus)
  devicesById.value = nextStore
}

function sortedChannels(device) {
  return Object.entries(device.channels || {}).sort((a, b) => Number(a[0]) - Number(b[0]))
}

function channelCount(device) {
  return Object.keys(device.channels || {}).length
}

function isBatteryLow(device) {
  const batteryPercent = Number(device.batteryPercent ?? 0)
  return batteryPercent > 0 && batteryPercent <= 25
}

function formatDuration(totalSeconds) {
  const safe = Math.max(0, Number(totalSeconds) || 0)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe % 60

  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

function formatMinutes(minutes) {
  return formatDuration(Number(minutes || 0) * 60)
}

function formatDateTimeLocal(value) {
  if (!value) return 'No rain stop'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'No rain stop'

  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function toDateTimeLocalInput(value) {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')

  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function getLiveRemaining(channel) {
  if (!channel || !channel.isRunning) return 0

  const base = Number(channel._snapshotRemaining ?? channel.remainingLive ?? 0)
  const elapsed = Math.floor((now.value - (channel._snapshotAt || now.value)) / 1000)
  return Math.max(0, base - elapsed)
}

function isChannelRunning(channel) {
  return Boolean(channel?.isRunning && getLiveRemaining(channel) > 0)
}

function getInputMinutes(deviceId, channelId) {
  const key = channelKey(deviceId, channelId)
  const value = Number(durationInputs.value[key])

  if (Number.isFinite(value) && value > 0) return Math.round(value)
  return getDefaultChannelConfig(deviceId, channelId).defaultOpenMinutes
}

function setDurationInput(deviceId, channelId, event) {
  const value = Number(event?.target?.value)
  durationInputs.value = {
    ...durationInputs.value,
    [channelKey(deviceId, channelId)]: Number.isFinite(value) && value > 0 ? Math.round(value) : '',
  }
}

function setPreset(deviceId, channelId, minutes) {
  durationInputs.value = {
    ...durationInputs.value,
    [channelKey(deviceId, channelId)]: minutes,
  }
}

function isPending(deviceId, channelId, action) {
  return pending.value.has(pendingKey(deviceId, channelId, action))
}

function sendValve(deviceId, channelId, action) {
  const key = pendingKey(deviceId, channelId, action)
  const next = new Set(pending.value)
  next.add(key)
  pending.value = next

  const minutes = getInputMinutes(deviceId, channelId)
  const duration = Math.max(60, minutes * 60)

  socket.emit('setValve', {
    valveId: Number(deviceId),
    channelId: Number(channelId),
    state: action,
    duration,
  })

  window.setTimeout(() => {
    const cleanup = new Set(pending.value)
    cleanup.delete(key)
    pending.value = cleanup
  }, 2200)
}

function togglePairing() {
  if (pairingBusy.value) return

  pairingBusy.value = true
  const nextMode = !pairingMode.value
  socket.emit('setPairingMode', { enabled: nextMode })

  window.setTimeout(() => {
    pairingBusy.value = false
  }, 1800)
}

function openRawEditor() {
  rawJsonError.value = ''
  rawJsonContent.value = 'Loading...'
  isRestarting.value = false
  activeSheet.value = 'rawEdit'
  activeChannel.value = null

  socket.emit('getRawDevicesJson', {}, (response) => {
    if (response?.ok && response?.data) {
      rawJsonContent.value = response.data
    } else {
      rawJsonContent.value = ''
      rawJsonError.value = response?.error || 'Could not load devices.json'
    }
  })
}

function saveRawJson() {
  if (isRestarting.value) return

  rawJsonError.value = ''
  let parsed = null

  try {
    parsed = JSON.parse(rawJsonContent.value)
  } catch (err) {
    rawJsonError.value = 'Invalid JSON: ' + err.message
    return
  }

  isRestarting.value = true
  socket.emit('saveRawDevicesJson', { rawJson: JSON.stringify(parsed, null, 2) }, (response) => {
    if (response?.ok) {
      // Backend is restarting
      setTimeout(() => {
        window.location.reload()
      }, 3000)
    } else {
      isRestarting.value = false
      rawJsonError.value = response?.error || 'Failed to save devices.json'
    }
  })
}

function openSheet(type, deviceId, channelId) {
  activeSheet.value = type
  activeChannel.value = {
    deviceId: Number(deviceId),
    channelId: Number(channelId),
  }

  const config = getDefaultChannelConfig(deviceId, channelId)

  if (type === 'plan') {
    planEditorSchedules.value = cloneSchedules(config.schedules || [])
    planDirty.value = false
    planForm.startTime = '06:00'
    planForm.durationMinutes = Math.max(1, Number(config.defaultOpenMinutes || 10))
    planForm.mistOnSeconds = 10
    planForm.mistOffSeconds = 30
  } else {
    configDraft.defaultOpenMinutes = Math.max(1, Number(config.defaultOpenMinutes || 10))
    configDraft.rainStopUntil = toDateTimeLocalInput(config.rainStopUntil)
  }
}

function closeSheet() {
  activeSheet.value = null
  activeChannel.value = null
}

function getActiveConfig() {
  if (!activeChannel.value) return null
  return getDefaultChannelConfig(activeChannel.value.deviceId, activeChannel.value.channelId)
}

function dayLabel(day) {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][Number(day) - 1] || '?'
}

function describePlan(plan) {
  const repeatText = plan.repeat === 'daily'
    ? 'Every day'
    : plan.repeat === 'odd'
      ? 'Odd dates'
      : plan.repeat === 'even'
        ? 'Even dates'
        : `Days: ${(plan.weekdays || []).map(dayLabel).join(', ')}`

  if (plan.mode === 'mist') {
    return `${repeatText} · Total duration ${plan.durationMinutes} min · Run time ${plan.mistOnSeconds}s · Interval ${plan.mistOffSeconds}s`
  }

  return `${repeatText} · Duration ${plan.durationMinutes} min`
}

function scheduleCount(deviceId, channelId) {
  return getDefaultChannelConfig(deviceId, channelId).schedules.length
}

function rainStopText(deviceId, channelId) {
  const value = getDefaultChannelConfig(deviceId, channelId).rainStopUntil
  return value ? formatDateTimeLocal(value) : 'Off'
}

function nextPlanLabel(deviceId, channelId) {
  const schedules = getDefaultChannelConfig(deviceId, channelId).schedules
  return schedules.length ? describePlan(schedules[0]).split(' · ')[0] : 'No schedule'
}

function selectRepeat(value) {
  planDraft.repeat = value
  if (value !== 'custom' && planDraft.weekdays.length === 0) {
    planDraft.weekdays = [1, 3, 5]
  }
}

function toggleWeekday(day) {
  if (planDraft.weekdays.includes(day)) {
    planDraft.weekdays = planDraft.weekdays.filter((item) => item !== day)
  } else if (planDraft.weekdays.length < 7) {
    planDraft.weekdays = [...planDraft.weekdays, day]
  }
}

function addPlanToEditor() {
  const startTime = planForm.startTime || '06:00'
  const durationMinutes = Math.max(1, Math.min(1440, Number(planForm.durationMinutes) || 10))
  const mistOnSeconds = Math.max(1, Math.min(3600, Number(planForm.mistOnSeconds) || 10))
  const mistOffSeconds = Math.max(1, Math.min(3600, Number(planForm.mistOffSeconds) || 30))

  if (planDraft.repeat === 'custom' && planDraft.weekdays.length === 0) {
    planDraft.weekdays = [1]
  }

  const plan = {
    id: `plan-${Date.now()}`,
    mode: planDraft.mode,
    startTime,
    durationMinutes,
    repeat: planDraft.repeat,
    weekdays: planDraft.repeat === 'custom'
      ? [...planDraft.weekdays].sort((a, b) => a - b)
      : [],
  }

  if (planDraft.mode === 'mist') {
    plan.mistOnSeconds = mistOnSeconds
    plan.mistOffSeconds = mistOffSeconds
  }

  planEditorSchedules.value = [...planEditorSchedules.value, plan]
  planDirty.value = true
}

function deletePlan(planId) {
  planEditorSchedules.value = planEditorSchedules.value.filter((item) => item.id !== planId)
  planDirty.value = true
}

function saveAllPlans(closeAfter = true) {
  const config = getActiveConfig()
  if (!config || !activeChannel.value) return

  const schedules = cloneSchedules(planEditorSchedules.value)
  config.schedules = schedules
  planDirty.value = false

  socket.emit('saveSchedules', {
    valveId: activeChannel.value.deviceId,
    channelId: activeChannel.value.channelId,
    schedules,
  })

  if (closeAfter) {
    closeSheet()
  }
}

function requestCloseSheet() {
  if (activeSheet.value === 'plan' && planDirty.value) {
    saveAllPlans(true)
    return
  }

  closeSheet()
}

function triggerOtaUpdate(gatewayId) {
  if (confirm(`Do you really want to start the firmware update for Gateway ${gatewayId}? The gateway will be offline for a few minutes.`)) {
    socket.emit('triggerOtaUpdate', { gatewayId })
  }
}

function addManualGateway() {
  const ip = prompt('Please enter the IP address of the Gateway (e.g. 192.168.1.50):')
  if (ip && ip.trim() !== '') {
    socket.emit('addManualGateway', { ip: ip.trim() })
  }
}

function removeGateway(id) {
  if (confirm(`Do you really want to remove the manual gateway ${id}?`)) {
    socket.emit('removeManualGateway', { id })
  }
}

function removeDevice(valveId) {
  if (confirm(`Do you really want to remove the device with ID ${valveId}? You might need to re-pair it to use it again.`)) {
    socket.emit('removeDevice', { valveId })
  }
}

function formatTimestamp(timestamp) {
  if (!timestamp) return 'Unknown'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

async function downloadJoinLog(valveId) {
  try {
    const basePath = window.location.pathname.endsWith('/') 
      ? window.location.pathname 
      : window.location.pathname + '/'
    const urlPath = `${basePath}api/diagnostic/download-join-log/${valveId}`
    
    const response = await fetch(urlPath)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = await response.json()
    
    const filename = `join-log-valve-${valveId}-${new Date().toISOString().split('T')[0]}.json`
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (err) {
    console.error('Download failed:', err)
    alert(`Failed to download join log: ${err.message}`)
  }
}

function cancelPlanEditing() {
  planEditorSchedules.value = []
  planDirty.value = false
  closeSheet()
}

function saveChannelConfig() {
  const config = getActiveConfig()
  if (!config || !activeChannel.value) return

  config.defaultOpenMinutes = Math.max(1, Math.min(1440, Number(configDraft.defaultOpenMinutes) || 10))
  config.rainStopUntil = configDraft.rainStopUntil || ''

  socket.emit('saveChannelConfig', {
    valveId: activeChannel.value.deviceId,
    channelId: activeChannel.value.channelId,
    config: {
      defaultOpenMinutes: config.defaultOpenMinutes,
      defaultOpenSeconds: config.defaultOpenMinutes * 60,
      rainStopUntil: config.rainStopUntil,
    },
  })

  closeSheet()
}

function clearRainStop() {
  configDraft.rainStopUntil = ''
}

function handleConnect() {
  socketConnected.value = true
  resetHeartbeatState()
  socket.emit('getPairingMode')
  socket.emit('getGateways')
  socket.emit('getDiagnosticLogs')
  sendHeartbeat()
}

function handleDisconnect() {
  socketConnected.value = false
  scheduleSilentReconnect()
}

function handleConnectError() {
  socketConnected.value = false
}

function handleInitialState(devices) {
  setInitialDevices(devices)
}

function handleDeviceUpdate(device) {
  if (!device || typeof device !== 'object') return
  mergeDeviceUpdate(device)
}

function handlePairingState({ enabled }) {
  pairingBusy.value = false
  pairingMode.value = Boolean(enabled)
  pairingKnown.value = true
}

function handleChannelConfigState({ valveId, channelId, config }) {
  if (!Number.isFinite(Number(valveId)) || !Number.isFinite(Number(channelId)) || !config) return

  const target = getDefaultChannelConfig(valveId, channelId)

  if (Number.isFinite(Number(config.defaultOpenMinutes))) {
    target.defaultOpenMinutes = Number(config.defaultOpenMinutes)
  } else if (Number.isFinite(Number(config.defaultOpenSeconds))) {
    target.defaultOpenMinutes = Math.max(1, Math.round(Number(config.defaultOpenSeconds) / 60))
  }

  if (typeof config.rainStopUntil === 'string') {
    target.rainStopUntil = config.rainStopUntil
  }

  if (Array.isArray(config.schedules)) {
    target.schedules = config.schedules.map(normalizeSchedule)
  }

  if (
    activeSheet.value === 'config' &&
    activeChannel.value &&
    Number(activeChannel.value.deviceId) === Number(valveId) &&
    Number(activeChannel.value.channelId) === Number(channelId)
  ) {
    configDraft.defaultOpenMinutes = Math.max(1, Number(target.defaultOpenMinutes || 10))
    configDraft.rainStopUntil = toDateTimeLocalInput(target.rainStopUntil)
  }
}

function handleDiagnosticLogs(logs) {
  diagnosticLogs.value = Array.isArray(logs) ? logs : []
}

onMounted(async () => {
  themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  syncTheme(themeMediaQuery)

  if (themeMediaQuery.addEventListener) {
    themeMediaQuery.addEventListener('change', syncTheme)
  } else {
    themeMediaQuery.addListener(syncTheme)
  }

  socket = await createSocket()
  socketConnected.value = socket.connected

  socket.on('connect', handleConnect)
  socket.on('disconnect', handleDisconnect)
  socket.on('connect_error', handleConnectError)
  socket.on('initialState', handleInitialState)
  socket.on('deviceUpdate', handleDeviceUpdate)
  socket.on('pairingState', handlePairingState)
  socket.on('channelConfigState', handleChannelConfigState)
  socket.on('gatewaysState', (gws) => { gateways.value = Array.isArray(gws) ? gws : [] })
  socket.on('diagnosticLogs', handleDiagnosticLogs)

  intervalId = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)

  startHeartbeat()
})

onUnmounted(() => {
  socket?.off('connect', handleConnect)
  socket?.off('disconnect', handleDisconnect)
  socket?.off('connect_error', handleConnectError)
  socket?.off('initialState', handleInitialState)
  socket?.off('deviceUpdate', handleDeviceUpdate)
  socket?.off('pairingState', handlePairingState)
  socket?.off('channelConfigState', handleChannelConfigState)
  socket?.off('gatewaysState')
  socket?.off('diagnosticLogs', handleDiagnosticLogs)

  stopHeartbeat()
  clearReconnectTimer()

  if (intervalId) {
    window.clearInterval(intervalId)
    intervalId = null
  }

  if (themeMediaQuery) {
    if (themeMediaQuery.removeEventListener) {
      themeMediaQuery.removeEventListener('change', syncTheme)
    } else {
      themeMediaQuery.removeListener(syncTheme)
    }
  }
})
</script>

<style>
:root {
  color-scheme: light;

  --body-bg: #eef2ec;
  --page-bg: linear-gradient(180deg, #fafbf8 0%, #f2f4ee 100%);
  --surface-panel: rgba(255, 255, 255, 0.92);
  --surface-card: #ffffff;
  --surface-soft: #f2f4ee;
  --surface-subtle: #fbfcf9;

  --text-primary: #1f2a1f;
  --text-muted: #667063;

  --border-soft: #e5e8de;
  --border-success: #cfe4d5;
  --border-danger: #ead1d1;
  --border-warning: #f0e1b9;

  --success-bg: #e8f4eb;
  --success-text: #2f7d4b;

  --danger-bg: #f8eaea;
  --danger-text: #b64b4b;

  --warning-bg: #fbf3e1;
  --warning-text: #c58b2b;

  --shadow-panel: 0 12px 32px rgba(41, 56, 39, 0.08);
  --shadow-strong: 0 24px 70px rgba(24, 35, 22, 0.2);
  --overlay: rgba(23, 31, 23, 0.34);
}

html.dark {
  color-scheme: dark;

  --body-bg: #0f1411;
  --page-bg: linear-gradient(180deg, #161d18 0%, #0f1411 100%);
  --surface-panel: rgba(24, 31, 26, 0.92);
  --surface-card: #18201b;
  --surface-soft: #1d2620;
  --surface-subtle: #202a23;

  --text-primary: #edf3ee;
  --text-muted: #a7b2aa;

  --border-soft: #2b362e;
  --border-success: rgba(100, 190, 132, 0.35);
  --border-danger: rgba(225, 110, 110, 0.28);
  --border-warning: rgba(230, 185, 90, 0.3);

  --success-bg: rgba(47, 125, 75, 0.18);
  --success-text: #8fd4a6;

  --danger-bg: rgba(182, 75, 75, 0.18);
  --danger-text: #f0a1a1;

  --warning-bg: rgba(197, 139, 43, 0.18);
  --warning-text: #f0c97b;

  --shadow-panel: 0 12px 32px rgba(0, 0, 0, 0.28);
  --shadow-strong: 0 24px 70px rgba(0, 0, 0, 0.45);
  --overlay: rgba(0, 0, 0, 0.55);
}

html,
body,
#app {
  min-height: 100%;
  margin: 0;
  background: var(--body-bg);
  color: var(--text-primary);
}

body {
  transition: background-color 0.2s ease, color 0.2s ease;
}

button,
input,
select,
textarea {
  color: inherit;
}

button {
  cursor: pointer;
}

button:disabled {
  cursor: wait;
}

.app-shell {
  min-height: 100vh;
  background: var(--page-bg);
  color: var(--text-primary);
}

.theme-panel {
  border-color: var(--border-soft);
  background: var(--surface-panel);
  box-shadow: var(--shadow-panel);
}

.theme-card {
  border-color: var(--border-soft);
  background: var(--surface-card);
  box-shadow: var(--shadow-panel);
}

.theme-soft {
  border-color: var(--border-soft);
  background: var(--surface-soft);
}

.theme-subtle {
  border-color: var(--border-soft);
  background: var(--surface-subtle);
}

.theme-text-muted {
  color: var(--text-muted);
}

.theme-button-secondary {
  border-color: var(--border-soft);
  background: var(--surface-soft);
  color: var(--text-primary);
}

.theme-button-primary {
  border-color: var(--success-text);
  background: var(--success-text);
  color: #ffffff;
}

.theme-button-danger {
  border-color: var(--border-danger);
  background: var(--surface-card);
  color: var(--danger-text);
}

.theme-chip-success {
  border-color: var(--border-success);
  background: var(--success-bg);
  color: var(--success-text);
}

.theme-chip-danger {
  border-color: var(--border-danger);
  background: var(--danger-bg);
  color: var(--danger-text);
}

.theme-chip-warning {
  border-color: var(--border-warning);
  background: var(--warning-bg);
  color: var(--warning-text);
}

.theme-chip-neutral {
  border-color: transparent;
  background: var(--surface-soft);
  color: var(--text-primary);
}

.theme-input {
  border-color: var(--border-soft);
  background: var(--surface-card);
  color: var(--text-primary);
}

.theme-modal {
  border-color: var(--border-soft);
  background: var(--surface-card);
  box-shadow: var(--shadow-strong);
}

.theme-overlay {
  background: var(--overlay);
}
</style>
