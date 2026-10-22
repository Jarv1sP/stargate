package main

import "errors"

func selectDarwinRoute(rows []route) (route, error) {
	var chosen route
	found, ambiguous := false, false
	for _, row := range rows {
		if !found || row.Metric < chosen.Metric {
			chosen, found, ambiguous = row, true, false
		} else if row.Metric == chosen.Metric && row != chosen {
			ambiguous = true
		}
	}
	if !found || ambiguous {
		return route{}, errors.New("PHYSICAL_ROUTE_UNAVAILABLE")
	}
	return chosen, nil
}
