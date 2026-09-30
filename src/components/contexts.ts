import { createContext } from "react";
import type { TrackCheck } from "../hooks/useSchedulerStatus";
import type { TrackerMarkerStyle } from "../types";

export const TrackerMarkerStyleContext = createContext<TrackerMarkerStyle>("icons");
export const CheckActivityContext = createContext<TrackCheck>((work) => work);
