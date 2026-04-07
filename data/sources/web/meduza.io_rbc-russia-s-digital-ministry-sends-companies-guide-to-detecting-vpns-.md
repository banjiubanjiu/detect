**原始链接：** https://meduza.io/en/news/2026/04/06/rbc-russia-s-digital-ministry-sends-companies-guide-to-detecting-vpns-on-user-devices-notes-iphones-pose-challenge

---


# RBC: Russia’s digital ministry sends companies guide to detecting VPNs on user devices, notes iPhones pose challenge

Russia’s Digital Development Ministry has sent the country’s largest internet companies a guide to detecting VPN services on user devices, the Russian business news outlet RBC reported, saying it had obtained a copy of the document, whose authenticity was confirmed by sources in the IT industry.

The ministry distributed the guide as a follow-up to meetings with companies at which officials announced requirements to restrict VPN use.

According to the document, companies must check whether a VPN is active on a user’s device in three stages: identifying the device’s IP address and comparing it against addresses considered Russian and against a list of blocked addresses; checking for VPN use through the company’s own app installed on the device; and checking for VPN use on devices running operating systems other than iOS and Android.

The ministry noted that the second stage — checking for VPN use through an app installed on the device — is difficult on iPhones because iOS significantly restricts access to system settings. On iOS, all third-party apps are sandboxed and cannot collect or modify information stored in other apps. Android is different: it uses ConnectivityManager and NetworkCapabilities, which allow any app to query the parameters of the active network and determine whether internet traffic is being routed through a VPN.

The guide also describes situations in which detecting a VPN is difficult or impossible — for example, when a VPN is configured at the router level. In that case, no local artifacts are present on the device itself, making it impossible to detect the circumvention tool.

The ministry also stated that a whitelist will be created for corporate VPNs that businesses use to give employees secure remote access to work resources. The list would include recognized corporate VPNs and legitimate proxy servers.

The guide also advises against running continuous VPN scans on user devices, warning that doing so would negatively affect data usage and battery consumption.

Russia’s largest platforms by audience were asked by the Digital Development Ministry to block users with active VPNs by April 15, the Russian business news outlet RBC reported. Minister Maksut Shadayev announced the requirement at a March 30 meeting with representatives of more than 20 companies, including Sberbank, Yandex, VK, Wildberries & Russ, Ozon, Gazprom-Media, Avito, X5 Group, and others. The authorities also threatened to revoke Digital Development Ministry IT accreditation from developers whose services continued to function when users had VPNs enabled.

Acting on instructions from Vladimir Putin, the Digital Development Ministry asked telecom operators to charge customers for traffic generated through VPN services, the Russian business outlet Forbes reported. The ministry proposed billing users who consume more than 15 gigabytes of international mobile traffic per month through VPNs, though how this would be determined remains unclear. Shadayev also did not rule out that Russia might in the future introduce administrative liability for VPN use.

At Meduza, we are committed to transparency about our use of artificial intelligence in the newsroom. The story you’re reading was written by one of our living, breathing journalists and translated from Russian using an AI model configured to follow our strict editorial standards. This translation process is the result of extensive testing and refinements to ensure our English-language coverage is timely and accurate. A Meduza editor reviews every draft before publication.

If you find any errors in this translation, please contact us at [email protected].

To read Meduza’s exclusive content in English, please subscribe to our newsletter.