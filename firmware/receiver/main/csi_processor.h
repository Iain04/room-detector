#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Features for one 1-second window. The firmware only measures; the backend
 * decides whether the room is occupied. */
typedef struct {
    float motion_score;   /* mean over valid subcarriers of amplitude std-dev */
    float motion_max;     /* max packet-to-packet mean amplitude change */
    float baseline_diff;  /* normalised mean |window mean - baseline| */
    float motion_excess;  /* motion_score minus the empty-room noise floor (>= 0); 0 if uncalibrated */
    int rssi;             /* mean RSSI (dBm) */
    int packet_rate;      /* CSI packets received in the window */
    int valid_subcarriers;
    bool calibrated;      /* false => baseline_diff is 0 because no baseline exists */
} csi_window_t;

typedef void (*csi_window_cb_t)(const csi_window_t *window);

/* Called when calibration finishes. ok=false means no packets were received.
 * noise_floor is the empty room's mean motion_score. */
typedef void (*csi_calibration_cb_t)(bool ok, int subcarriers, uint32_t packets, float noise_floor);

/* sender_mac may be NULL to accept CSI from any transmitter. */
esp_err_t csi_processor_start(const uint8_t *sender_mac,
                              csi_window_cb_t window_cb,
                              csi_calibration_cb_t calibration_cb);

/* Enable CSI (plus promiscuous RX for sender mode). Call after esp_wifi_start(). */
esp_err_t csi_processor_enable_wifi_csi(bool promiscuous);

/* Record the empty-room baseline for `seconds`, then save it to NVS. */
esp_err_t csi_processor_request_calibration(int seconds);

#ifdef __cplusplus
}
#endif
