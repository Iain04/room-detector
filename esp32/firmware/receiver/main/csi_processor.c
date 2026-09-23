/*
 * CSI capture and per-window feature extraction.
 *
 * The Wi-Fi CSI callback only filters by sender MAC and copies the raw
 * buffer into a queue. A worker task converts it to per-subcarrier amplitudes
 * and computes features once per second.
 *
 * CSI buffer layout (ESP32-S3, LLTF): 64 subcarriers, each stored as a pair of
 * signed int8 values [imaginary, real]. Subcarrier index 0 is DC and indices
 * 27..37 are guard/null subcarriers; these are always excluded, as is any
 * subcarrier whose amplitude is near zero.
 */
#include "csi_processor.h"

#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs.h"

#define CSI_MAX_SUBCARRIERS 64
#define CSI_MAX_BYTES (CSI_MAX_SUBCARRIERS * 2)
#define CSI_QUEUE_LEN 64
#define WINDOW_US 1000000LL
#define MIN_AMPLITUDE (CONFIG_CSI_MIN_AMPLITUDE_X10 / 10.0f)
#define CAL_MIN_SECONDS 5
#define CAL_MAX_SECONDS 600

#define NVS_NAMESPACE "csi"
#define NVS_KEY_BASELINE "baseline"

static const char *TAG = "csi_proc";

typedef struct {
    int8_t buf[CSI_MAX_BYTES];
    uint16_t len;
    int8_t rssi;
    bool first_word_invalid;
} csi_packet_t;

static QueueHandle_t s_packet_queue;
static QueueHandle_t s_cmd_queue;
static uint8_t s_sender_mac[6];
static bool s_filter_mac;
static volatile uint32_t s_dropped;
static csi_window_cb_t s_window_cb;
static csi_calibration_cb_t s_calibration_cb;

/* Worker-task state (only touched by the worker). */
static float s_baseline[CSI_MAX_SUBCARRIERS];
static int s_baseline_n;

static bool is_null_subcarrier(int k)
{
    return k == 0 || (k >= 27 && k <= 37);
}

/* ---------------------------------------------------------------- NVS */

static void baseline_load(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) != ESP_OK) {
        ESP_LOGW(TAG, "No baseline stored yet; send a calibrate command in an empty room");
        return;
    }
    size_t size = sizeof(s_baseline);
    esp_err_t err = nvs_get_blob(h, NVS_KEY_BASELINE, s_baseline, &size);
    nvs_close(h);
    if (err == ESP_OK && size > 0 && size % sizeof(float) == 0) {
        s_baseline_n = size / sizeof(float);
        ESP_LOGI(TAG, "Loaded empty-room baseline from NVS (%d subcarriers)", s_baseline_n);
    } else {
        s_baseline_n = 0;
        ESP_LOGW(TAG, "No baseline stored yet; send a calibrate command in an empty room");
    }
}

static esp_err_t baseline_save(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_blob(h, NVS_KEY_BASELINE, s_baseline, s_baseline_n * sizeof(float));
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err;
}

/* ---------------------------------------------------------------- callback */

static void csi_rx_cb(void *ctx, wifi_csi_info_t *info)
{
    if (info == NULL || info->buf == NULL || info->len == 0) {
        return;
    }
    if (s_filter_mac && memcmp(info->mac, s_sender_mac, 6) != 0) {
        return;
    }

    csi_packet_t pkt;
    pkt.len = info->len > CSI_MAX_BYTES ? CSI_MAX_BYTES : info->len;
    memcpy(pkt.buf, info->buf, pkt.len);
    pkt.rssi = info->rx_ctrl.rssi;
    pkt.first_word_invalid = info->first_word_invalid;

    if (xQueueSend(s_packet_queue, &pkt, 0) != pdTRUE) {
        s_dropped++;
    }
}

/* ---------------------------------------------------------------- worker */

typedef struct {
    double sum[CSI_MAX_SUBCARRIERS];
    double sumsq[CSI_MAX_SUBCARRIERS];
    uint32_t count[CSI_MAX_SUBCARRIERS];
    uint32_t packets;
    int32_t rssi_sum;
    float max_delta;
    int n_sc;
} window_acc_t;

typedef struct {
    bool active;
    int64_t end_us;
    double sum[CSI_MAX_SUBCARRIERS];
    uint32_t count[CSI_MAX_SUBCARRIERS];
    uint32_t packets;
    int n_sc;
} calibration_t;

static int packet_amplitudes(const csi_packet_t *pkt, float amp[CSI_MAX_SUBCARRIERS],
                             bool valid[CSI_MAX_SUBCARRIERS])
{
    int n_sc = pkt->len / 2;
    for (int k = 0; k < n_sc; k++) {
        float im = pkt->buf[2 * k];
        float re = pkt->buf[2 * k + 1];
        amp[k] = sqrtf(re * re + im * im);
        valid[k] = !is_null_subcarrier(k) && amp[k] >= MIN_AMPLITUDE;
    }
    if (pkt->first_word_invalid && n_sc >= 2) {
        valid[0] = valid[1] = false;
    }
    return n_sc;
}

static void debug_print_raw(const csi_packet_t *pkt)
{
#if CONFIG_CSI_DEBUG_RAW
    static uint32_t n;
    if (++n % CONFIG_CSI_DEBUG_PRINT_EVERY_N != 0) {
        return;
    }
    printf("CSI_DATA,%d,%u,[", pkt->rssi, pkt->len);
    for (int i = 0; i < pkt->len; i++) {
        printf(i ? ",%d" : "%d", pkt->buf[i]);
    }
    printf("]\n");
#else
    (void)pkt;
#endif
}

static void finish_window(window_acc_t *w)
{
    csi_window_t out = {
        .packet_rate = (int)w->packets,
        .calibrated = s_baseline_n > 0,
        .motion_max = w->max_delta,
    };

    if (w->packets > 0) {
        out.rssi = (int)lroundf((float)w->rssi_sum / w->packets);

        double std_sum = 0, diff_sum = 0, base_sum = 0;
        int n_valid = 0, n_base = 0;
        for (int k = 0; k < w->n_sc; k++) {
            /* Require the subcarrier to be valid in at least half of the packets. */
            if (w->count[k] == 0 || w->count[k] * 2 < w->packets) {
                continue;
            }
            double mean = w->sum[k] / w->count[k];
            if (mean < MIN_AMPLITUDE) {
                continue;
            }
            double var = w->sumsq[k] / w->count[k] - mean * mean;
            std_sum += var > 0 ? sqrt(var) : 0;
            n_valid++;

            if (k < s_baseline_n && s_baseline[k] >= MIN_AMPLITUDE) {
                diff_sum += fabs(mean - s_baseline[k]);
                base_sum += s_baseline[k];
                n_base++;
            }
        }
        out.valid_subcarriers = n_valid;
        out.motion_score = n_valid ? (float)(std_sum / n_valid) : 0;
        if (n_base > 0 && base_sum > 0) {
            out.baseline_diff = (float)((diff_sum / n_base) / (base_sum / n_base));
        }
    }

    if (s_window_cb) {
        s_window_cb(&out);
    }
}

static void finish_calibration(calibration_t *cal)
{
    cal->active = false;
    if (cal->packets == 0) {
        ESP_LOGE(TAG, "Calibration failed: no CSI packets received (is the sender running?)");
        if (s_calibration_cb) {
            s_calibration_cb(false, 0, 0);
        }
        return;
    }

    s_baseline_n = cal->n_sc;
    for (int k = 0; k < s_baseline_n; k++) {
        s_baseline[k] = cal->count[k] ? (float)(cal->sum[k] / cal->count[k]) : 0.0f;
    }
    esp_err_t err = baseline_save();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Saving baseline to NVS failed: %s", esp_err_to_name(err));
    }
    ESP_LOGI(TAG, "Calibration complete: %" PRIu32 " packets, %d subcarriers", cal->packets, s_baseline_n);
    if (s_calibration_cb) {
        s_calibration_cb(err == ESP_OK, s_baseline_n, cal->packets);
    }
}

static void worker_task(void *arg)
{
    static window_acc_t win;
    static calibration_t cal;
    static float prev_amp[CSI_MAX_SUBCARRIERS];
    static bool prev_valid[CSI_MAX_SUBCARRIERS];
    static bool have_prev;

    memset(&win, 0, sizeof(win));
    memset(&cal, 0, sizeof(cal));
    int64_t next_window_us = esp_timer_get_time() + WINDOW_US;
    uint32_t last_dropped = 0;

    for (;;) {
        int seconds;
        if (xQueueReceive(s_cmd_queue, &seconds, 0) == pdTRUE) {
            memset(&cal, 0, sizeof(cal));
            cal.active = true;
            cal.end_us = esp_timer_get_time() + (int64_t)seconds * 1000000;
            ESP_LOGI(TAG, "Calibrating empty-room baseline for %d s - keep the room empty", seconds);
        }

        int64_t now = esp_timer_get_time();
        TickType_t wait = 0;
        if (next_window_us > now) {
            wait = pdMS_TO_TICKS((next_window_us - now) / 1000);
            if (wait == 0) {
                wait = 1;
            }
        }

        csi_packet_t pkt;
        if (xQueueReceive(s_packet_queue, &pkt, wait) == pdTRUE) {
            float amp[CSI_MAX_SUBCARRIERS];
            bool valid[CSI_MAX_SUBCARRIERS];
            int n_sc = packet_amplitudes(&pkt, amp, valid);
            debug_print_raw(&pkt);

            if (win.n_sc == 0 || n_sc < win.n_sc) {
                win.n_sc = n_sc;
            }
            win.packets++;
            win.rssi_sum += pkt.rssi;

            double delta_sum = 0;
            int delta_n = 0;
            for (int k = 0; k < n_sc; k++) {
                if (!valid[k]) {
                    continue;
                }
                win.sum[k] += amp[k];
                win.sumsq[k] += (double)amp[k] * amp[k];
                win.count[k]++;
                if (have_prev && prev_valid[k]) {
                    delta_sum += fabsf(amp[k] - prev_amp[k]);
                    delta_n++;
                }
                if (cal.active) {
                    cal.sum[k] += amp[k];
                    cal.count[k]++;
                }
            }
            if (delta_n > 0) {
                float delta = (float)(delta_sum / delta_n);
                if (delta > win.max_delta) {
                    win.max_delta = delta;
                }
            }
            if (cal.active) {
                cal.packets++;
                if (cal.n_sc == 0 || n_sc < cal.n_sc) {
                    cal.n_sc = n_sc;
                }
            }
            memcpy(prev_amp, amp, sizeof(float) * n_sc);
            memcpy(prev_valid, valid, sizeof(bool) * n_sc);
            for (int k = n_sc; k < CSI_MAX_SUBCARRIERS; k++) {
                prev_valid[k] = false;
            }
            have_prev = true;
        }

        now = esp_timer_get_time();
        if (cal.active && now >= cal.end_us) {
            finish_calibration(&cal);
        }
        if (now >= next_window_us) {
            if (win.packets == 0) {
                have_prev = false; /* gap: don't compare across silent windows */
            }
            finish_window(&win);
            memset(&win, 0, sizeof(win));
            next_window_us += WINDOW_US;
            if (next_window_us <= now) {
                next_window_us = now + WINDOW_US; /* fell behind; resync */
            }
            if (s_dropped != last_dropped) {
                ESP_LOGW(TAG, "CSI queue full: %" PRIu32 " packets dropped so far", s_dropped);
                last_dropped = s_dropped;
            }
        }
    }
}

/* ---------------------------------------------------------------- API */

esp_err_t csi_processor_start(const uint8_t *sender_mac,
                              csi_window_cb_t window_cb,
                              csi_calibration_cb_t calibration_cb)
{
    s_window_cb = window_cb;
    s_calibration_cb = calibration_cb;
    s_filter_mac = sender_mac != NULL;
    if (sender_mac) {
        memcpy(s_sender_mac, sender_mac, 6);
    }

    baseline_load();

    s_packet_queue = xQueueCreate(CSI_QUEUE_LEN, sizeof(csi_packet_t));
    s_cmd_queue = xQueueCreate(2, sizeof(int));
    if (!s_packet_queue || !s_cmd_queue) {
        return ESP_ERR_NO_MEM;
    }
    if (xTaskCreate(worker_task, "csi_worker", 6144, NULL, 4, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

esp_err_t csi_processor_enable_wifi_csi(bool promiscuous)
{
    if (promiscuous) {
        /* Promiscuous RX (management frames only) lets us hear the sender's
         * ESP-NOW broadcasts while staying associated to the access point. */
        wifi_promiscuous_filter_t filter = {.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT};
        ESP_ERROR_CHECK(esp_wifi_set_promiscuous_filter(&filter));
        ESP_ERROR_CHECK(esp_wifi_set_promiscuous(true));
    }

    wifi_csi_config_t csi_config = {
        .lltf_en = true,
        .htltf_en = false,
        .stbc_htltf2_en = false,
        .ltf_merge_en = true,
        .channel_filter_en = true,
        .manu_scale = false,
        .shift = 0,
    };
    esp_err_t err = esp_wifi_set_csi_config(&csi_config);
    if (err == ESP_OK) {
        err = esp_wifi_set_csi_rx_cb(csi_rx_cb, NULL);
    }
    if (err == ESP_OK) {
        err = esp_wifi_set_csi(true);
    }
    return err;
}

esp_err_t csi_processor_request_calibration(int seconds)
{
    if (seconds < CAL_MIN_SECONDS) {
        seconds = CAL_MIN_SECONDS;
    } else if (seconds > CAL_MAX_SECONDS) {
        seconds = CAL_MAX_SECONDS;
    }
    return xQueueSend(s_cmd_queue, &seconds, 0) == pdTRUE ? ESP_OK : ESP_ERR_INVALID_STATE;
}
